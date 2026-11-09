// Redaction helpers. Everything NetSpy exposes through MCP passes through
// here first. The goal is "safe by default": anything that looks like a
// credential is replaced with REDACTED before it leaves this process.

export const REDACTED = "[REDACTED]";

// Headers/keys that are always sensitive.
const EXACT_SENSITIVE = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-security-token",
]);

// Anything whose name contains one of these fragments is treated as sensitive.
const SENSITIVE_FRAGMENT =
  /(token|secret|passw(or)?d|passwd|pwd|api[-_]?key|apikey|auth|session|credential|signature|private[-_]?key|access[-_]?key|bearer|jwt|sid$)/i;

export function isSensitiveName(name) {
  const n = String(name).toLowerCase();
  return EXACT_SENSITIVE.has(n) || SENSITIVE_FRAGMENT.test(n);
}

/**
 * Normalise the many shapes `requestHeader` / `responseHeader` can take
 * (plain object, array of [k, v] pairs, Headers-like object serialised to {})
 * into a plain { name: value } object with sensitive values redacted.
 */
export function redactHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  const pairs = Array.isArray(headers) ? headers : Object.entries(headers);
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [name, value] = pair;
    if (typeof name !== "string") continue;
    out[name] = isSensitiveName(name) ? REDACTED : stringifyValue(value);
  }
  return out;
}

function stringifyValue(value) {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Redact credentials embedded in a URL: user:pass@host and sensitive query
 * parameters (api_key, token, access_token, signature, ...).
 */
export function redactUrl(raw) {
  if (typeof raw !== "string") return raw;
  try {
    const u = new URL(raw);
    if (u.username) u.username = REDACTED;
    if (u.password) u.password = REDACTED;
    for (const key of [...u.searchParams.keys()]) {
      if (isSensitiveName(key)) u.searchParams.set(key, REDACTED);
    }
    // URL percent-encodes the brackets; make the marker readable again.
    return u.toString().split(encodeURIComponent(REDACTED)).join(REDACTED);
  } catch {
    // Not a parseable URL (e.g. "unknown"): fall back to a regex pass.
    return raw.replace(
      /([?&][^=&#]*(?:token|secret|passw|key|auth|session|signature)[^=&#]*=)[^&#]*/gi,
      `$1${REDACTED}`,
    );
  }
}

/** Redact error messages, which sometimes echo URLs or tokens. */
export function redactText(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi, `$1 ${REDACTED}`)
    .replace(/https?:\/\/[^\s"')]+/g, (m) => redactUrl(m));
}

const MAX_BODY_CHARS = 2048;

/**
 * Describe a request body without exposing it. By default only metadata is
 * returned. With includeBodies=true, string bodies are returned truncated,
 * with sensitive JSON keys / form fields redacted.
 */
export function summarizeBody(body, { includeBodies = false } = {}) {
  if (body === undefined || body === null) return { present: false };
  const isString = typeof body === "string";
  const summary = {
    present: true,
    type: isString ? "string" : typeof body === "object" ? "object" : typeof body,
    sizeBytes: isString ? Buffer.byteLength(body) : undefined,
  };
  if (!includeBodies) {
    summary.omitted = "Body hidden by default. Start `netspy mcp --include-bodies` to expose redacted string bodies.";
    return summary;
  }
  if (!isString) {
    summary.omitted = "Only string bodies can be shown.";
    return summary;
  }
  let text = redactBodyString(body);
  if (text.length > MAX_BODY_CHARS) {
    text = text.slice(0, MAX_BODY_CHARS) + "… [truncated]";
    summary.truncated = true;
  }
  summary.content = text;
  return summary;
}

function redactBodyString(body) {
  try {
    return JSON.stringify(redactJson(JSON.parse(body)));
  } catch {
    // Not JSON: treat as urlencoded / plain text.
    return body.replace(
      /([?&]?[\w.\-[\]]+)=([^&\s]*)/g,
      (match, key) => (isSensitiveName(key.replace(/^[?&]/, "")) ? `${key}=${REDACTED}` : match),
    );
  }
}

function redactJson(value, depth = 0) {
  if (depth > 8) return "[max depth]";
  if (Array.isArray(value)) return value.map((v) => redactJson(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveName(k) ? REDACTED : redactJson(v, depth + 1);
    }
    return out;
  }
  return value;
}
