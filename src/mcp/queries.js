// Pure query logic over NetSpy's captured entries. No I/O, no MCP types, so it
// is easy to test. Every function returns already-redacted, JSON-safe data.

import {
  redactHeaders,
  redactText,
  redactUrl,
  summarizeBody,
} from "./redact.js";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;
export const DEFAULT_SLOW_THRESHOLD_MS = 1000;
export const DEFAULT_TOP_N = 10;
export const MAX_TOP_N = 50;

export class InputError extends Error {}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function isHttpError(entry) {
  return typeof entry.status === "number" && entry.status >= 400;
}

export function isFailed(entry) {
  return entry.status === "error" || isHttpError(entry);
}

function stateOf(entry) {
  if (entry.status === "error") return "error";
  if (typeof entry.status === "number") return "completed";
  return "pending";
}

function round(n) {
  return typeof n === "number" && Number.isFinite(n)
    ? Math.round(n * 100) / 100
    : null;
}

/** Compact, redacted view of one entry (used in lists). */
export function toSummary(entry) {
  const state = stateOf(entry);
  return {
    id: entry.id,
    method: entry.method,
    url: redactUrl(entry.url),
    state,
    status: typeof entry.status === "number" ? entry.status : null,
    statusText: entry.statusText || null,
    failed: isFailed(entry),
    durationMs: round(entry.duration),
    startedAt:
      typeof entry.startedAt === "number"
        ? new Date(entry.startedAt).toISOString()
        : null,
    via: entry.via || "fetch",
    error: entry.error ? redactText(String(entry.error)) : null,
  };
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/** Accepts epoch milliseconds (number) or an ISO-8601 date string. */
export function parseTime(value, name) {
  if (value === undefined || value === null) return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new InputError(
      `Invalid ${name}: expected an ISO-8601 date string or epoch milliseconds.`,
    );
  }
  return ms;
}

function parseStatusFilter(status) {
  if (status === undefined) return undefined;
  const s = String(status).toLowerCase();
  if (s === "error" || s === "pending") return { kind: s };
  if (/^[1-5]xx$/.test(s)) return { kind: "class", min: Number(s[0]) * 100 };
  if (/^[1-5]\d\d$/.test(s)) return { kind: "exact", code: Number(s) };
  throw new InputError(
    'Invalid status: use a code like 404, a class like "5xx", "error" (network error) or "pending".',
  );
}

function buildPredicate(args) {
  const method = args.method ? String(args.method).toUpperCase() : undefined;
  const status = parseStatusFilter(args.status);
  const needle = args.url_contains ? String(args.url_contains).toLowerCase() : undefined;
  const since = parseTime(args.since, "since");
  const until = parseTime(args.until, "until");
  if (since !== undefined && until !== undefined && since > until) {
    throw new InputError("`since` must not be later than `until`.");
  }

  return (entry) => {
    if (method && String(entry.method).toUpperCase() !== method) return false;
    if (status) {
      if (status.kind === "error" && entry.status !== "error") return false;
      if (status.kind === "pending" && stateOf(entry) !== "pending") return false;
      if (status.kind === "exact" && entry.status !== status.code) return false;
      if (
        status.kind === "class" &&
        !(
          typeof entry.status === "number" &&
          entry.status >= status.min &&
          entry.status < status.min + 100
        )
      )
        return false;
    }
    // Match against the *redacted* URL so filters can't be used to probe
    // secrets hidden in query strings.
    if (needle && !String(redactUrl(entry.url)).toLowerCase().includes(needle))
      return false;
    if (since !== undefined && !(entry.startedAt >= since)) return false;
    if (until !== undefined && !(entry.startedAt <= until)) return false;
    return true;
  };
}

function sortByTime(list, order = "desc") {
  const dir = order === "asc" ? 1 : -1;
  return [...list].sort((a, b) => dir * ((a.startedAt || 0) - (b.startedAt || 0)));
}

function clampLimit(limit, fallback = DEFAULT_LIMIT) {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InputError(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  return limit;
}

function clampOffset(offset) {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new InputError("offset must be a non-negative integer.");
  }
  return offset;
}

function page(list, args) {
  const limit = clampLimit(args.limit);
  const offset = clampOffset(args.offset);
  const items = list.slice(offset, offset + limit);
  const end = offset + items.length;
  return {
    totalMatched: list.length,
    returned: items.length,
    offset,
    limit,
    hasMore: end < list.length,
    nextOffset: end < list.length ? end : null,
    items,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function getRequests(entries, args = {}) {
  const matched = sortByTime(entries.filter(buildPredicate(args)), args.order);
  const { items, ...meta } = page(matched, args);
  return { ...meta, requests: items.map(toSummary) };
}

export function getFailedRequests(entries, args = {}) {
  const predicate = buildPredicate(args);
  const matched = sortByTime(
    entries.filter((e) => isFailed(e) && predicate(e)),
    args.order,
  );
  const { items, ...meta } = page(matched, args);
  const requests = items.map((e) => ({
    ...toSummary(e),
    failureType: e.status === "error" ? "network_error" : "http_error",
  }));
  return {
    ...meta,
    breakdown: {
      httpErrors: matched.filter((e) => e.status !== "error").length,
      networkErrors: matched.filter((e) => e.status === "error").length,
    },
    requests,
  };
}

export function getSlowRequests(entries, args = {}) {
  const threshold = args.threshold_ms ?? DEFAULT_SLOW_THRESHOLD_MS;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
    throw new InputError("threshold_ms must be a non-negative number.");
  }
  const predicate = buildPredicate(args);
  const matched = entries
    .filter(
      (e) => typeof e.duration === "number" && e.duration >= threshold && predicate(e),
    )
    .sort((a, b) => b.duration - a.duration);
  const { items, ...meta } = page(matched, args);
  return {
    ...meta,
    thresholdMs: threshold,
    requests: items.map(toSummary),
  };
}

export function getRequestDetails(entries, args = {}, { includeBodies = false } = {}) {
  const id = args.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    throw new InputError("id must be a non-empty string (max 128 chars).");
  }
  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    throw new InputError(
      `No captured request with id "${id.slice(0, 64)}". Use get_requests to list valid ids; history is capped and cleared when NetSpy restarts.`,
    );
  }
  return {
    ...toSummary(entry),
    requestHeaders: redactHeaders(entry.requestHeader),
    responseHeaders: redactHeaders(entry.responseHeader),
    requestBody: summarizeBody(entry.body, { includeBodies }),
    redactionNote:
      "Credentials in headers, URL query strings and bodies are replaced with [REDACTED].",
  };
}

// --- analysis --------------------------------------------------------------

const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/** `METHOD https://host/users/123` -> `GET https://host/users/:id` */
export function endpointKey(entry) {
  let target = String(entry.url);
  try {
    const u = new URL(entry.url);
    const path = u.pathname
      .split("/")
      .map((seg) => (ID_SEGMENT.test(seg) ? ":id" : seg))
      .join("/");
    target = `${u.protocol}//${u.host}${path}`;
  } catch {}
  return `${String(entry.method).toUpperCase()} ${redactUrl(target)}`;
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return round(sortedAsc[Math.max(0, idx)]);
}

function tally(list, keyFn) {
  const out = {};
  for (const item of list) {
    const k = keyFn(item);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

export function analyzeNetworkActivity(entries, args = {}) {
  const topN = args.top_n ?? DEFAULT_TOP_N;
  if (!Number.isInteger(topN) || topN < 1 || topN > MAX_TOP_N) {
    throw new InputError(`top_n must be an integer between 1 and ${MAX_TOP_N}.`);
  }
  const predicate = buildPredicate({ since: args.since, until: args.until });
  const list = entries.filter(predicate);

  const durations = list
    .map((e) => e.duration)
    .filter((d) => typeof d === "number" && Number.isFinite(d))
    .sort((a, b) => a - b);
  const sum = durations.reduce((a, b) => a + b, 0);

  const failed = list.filter(isFailed);
  const httpErrors = failed.filter((e) => e.status !== "error").length;
  const networkErrors = failed.length - httpErrors;

  const groups = new Map();
  const repeated = new Map();
  for (const e of list) {
    const key = endpointKey(e);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { endpoint: key, count: 0, failed: 0, durs: [] }));
    g.count++;
    if (isFailed(e)) g.failed++;
    if (typeof e.duration === "number") g.durs.push(e.duration);

    const exact = `${String(e.method).toUpperCase()} ${redactUrl(e.url)}`;
    repeated.set(exact, (repeated.get(exact) || 0) + 1);
  }
  const endpoints = [...groups.values()].map((g) => ({
    endpoint: g.endpoint,
    count: g.count,
    failed: g.failed,
    avgDurationMs: g.durs.length ? round(g.durs.reduce((a, b) => a + b, 0) / g.durs.length) : null,
    maxDurationMs: g.durs.length ? round(Math.max(...g.durs)) : null,
  }));

  const times = list.map((e) => e.startedAt).filter((t) => typeof t === "number");
  const hostOf = (e) => {
    try {
      return new URL(e.url).host;
    } catch {
      return "unknown";
    }
  };

  return {
    totalRequests: list.length,
    completed: list.filter((e) => stateOf(e) === "completed").length,
    pending: list.filter((e) => stateOf(e) === "pending").length,
    failedRequests: {
      total: failed.length,
      httpErrors,
      networkErrors,
      failureRate: list.length ? round(failed.length / list.length) : 0,
    },
    statusCodeDistribution: tally(
      list.filter((e) => typeof e.status === "number"),
      (e) => String(e.status),
    ),
    statusClassDistribution: tally(list, (e) =>
      typeof e.status === "number" ? `${Math.floor(e.status / 100)}xx` : stateOf(e),
    ),
    methodDistribution: tally(list, (e) => String(e.method).toUpperCase()),
    hostDistribution: tally(list, hostOf),
    duration: {
      measuredRequests: durations.length,
      averageMs: durations.length ? round(sum / durations.length) : null,
      minMs: durations.length ? round(durations[0]) : null,
      maxMs: durations.length ? round(durations[durations.length - 1]) : null,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
    },
    slowestEndpoints: endpoints
      .filter((e) => e.avgDurationMs !== null)
      .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
      .slice(0, topN),
    mostFrequentEndpoints: [...endpoints]
      .sort((a, b) => b.count - a.count)
      .slice(0, topN),
    endpointsWithMostFailures: endpoints
      .filter((e) => e.failed > 0)
      .sort((a, b) => b.failed - a.failed)
      .slice(0, topN),
    repeatedIdenticalRequests: [...repeated.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([request, count]) => ({ request, count })),
    timeRange: times.length
      ? {
          first: new Date(Math.min(...times)).toISOString(),
          last: new Date(Math.max(...times)).toISOString(),
        }
      : null,
    notes: [
      "Endpoints group numeric/UUID path segments as :id and ignore query strings.",
      "Durations are in milliseconds; pending requests have no duration.",
      "History is in-memory only (max 1000 entries) and resets when NetSpy restarts.",
    ],
  };
}
