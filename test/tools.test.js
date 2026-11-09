import test from "node:test";
import assert from "node:assert/strict";
import { SECRETS, T0, call, connect, makeEntries } from "./helpers.js";
import { SourceError } from "../src/mcp/source.js";

const TOOLS = [
  "get_requests",
  "get_failed_requests",
  "get_slow_requests",
  "get_request_details",
  "analyze_network_activity",
];

test("lists exactly the five read-only tools", async () => {
  const client = await connect(makeEntries());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS].sort());
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.ok(t.description.length > 40, `${t.name} needs a useful description`);
  }
});

// --- empty history ---------------------------------------------------------

test("every tool handles empty request history", async () => {
  const client = await connect([]);
  for (const name of ["get_requests", "get_failed_requests", "get_slow_requests"]) {
    const { data, isError } = await call(client, name);
    assert.equal(isError, false, name);
    assert.equal(data.totalMatched, 0);
    assert.deepEqual(data.requests, []);
    assert.equal(data.hasMore, false);
  }
  const { data } = await call(client, "analyze_network_activity");
  assert.equal(data.totalRequests, 0);
  assert.equal(data.duration.averageMs, null);
  assert.equal(data.failedRequests.failureRate, 0);
  assert.equal(data.timeRange, null);
  const details = await call(client, "get_request_details", { id: "x" });
  assert.equal(details.isError, true);
});

// --- get_requests ----------------------------------------------------------

test("get_requests returns newest first and respects order=asc", async () => {
  const client = await connect(makeEntries());
  const desc = (await call(client, "get_requests")).data;
  assert.equal(desc.totalMatched, 10);
  assert.equal(desc.requests[0].id, "id-10");
  const asc = (await call(client, "get_requests", { order: "asc" })).data;
  assert.equal(asc.requests[0].id, "id-1");
});

test("get_requests filters by method, status variants, url and time range", async () => {
  const client = await connect(makeEntries());
  const ids = async (args) => (await call(client, "get_requests", { ...args, order: "asc" })).data.requests.map((r) => r.id);

  assert.deepEqual(await ids({ method: "POST" }), ["id-3"]);
  assert.deepEqual(await ids({ status: 404 }), ["id-4"]);
  assert.deepEqual(await ids({ status: "5xx" }), ["id-3"]);
  assert.deepEqual(await ids({ status: "4XX" }), ["id-4"]);
  assert.deepEqual(await ids({ status: "error" }), ["id-5"]);
  assert.deepEqual(await ids({ status: "pending" }), ["id-7"]);
  assert.deepEqual(await ids({ url_contains: "USERS/" }), ["id-1", "id-2"]);
  assert.deepEqual(await ids({ url_contains: "health", method: "GET" }), ["id-8", "id-9", "id-10"]);
  assert.deepEqual(await ids({ since: new Date(T0 + 9000).toISOString() }), ["id-9", "id-10"]);
  assert.deepEqual(await ids({ until: T0 + 2000 }), ["id-1", "id-2"]);
  assert.deepEqual(await ids({ since: T0 + 3000, until: T0 + 4000 }), ["id-3", "id-4"]);
  assert.deepEqual(await ids({ url_contains: "nothing-matches" }), []);
});

test("get_requests paginates with limit/offset/nextOffset", async () => {
  const client = await connect(makeEntries());
  const p1 = (await call(client, "get_requests", { limit: 4, order: "asc" })).data;
  assert.equal(p1.returned, 4);
  assert.equal(p1.hasMore, true);
  assert.equal(p1.nextOffset, 4);
  const p2 = (await call(client, "get_requests", { limit: 4, offset: p1.nextOffset, order: "asc" })).data;
  assert.deepEqual(p2.requests.map((r) => r.id), ["id-5", "id-6", "id-7", "id-8"]);
  const p3 = (await call(client, "get_requests", { limit: 4, offset: 8, order: "asc" })).data;
  assert.equal(p3.returned, 2);
  assert.equal(p3.hasMore, false);
  assert.equal(p3.nextOffset, null);
  const beyond = (await call(client, "get_requests", { offset: 500 })).data;
  assert.equal(beyond.returned, 0);
  assert.equal(beyond.totalMatched, 10);
});

test("get_requests returns structuredContent matching the text payload", async () => {
  const client = await connect(makeEntries());
  const r = await call(client, "get_requests", { limit: 2 });
  assert.deepEqual(r.structured, r.data);
});

// --- failed ----------------------------------------------------------------

test("get_failed_requests returns HTTP and network errors with error info", async () => {
  const client = await connect(makeEntries());
  const { data } = await call(client, "get_failed_requests", { order: "asc" });
  assert.deepEqual(data.requests.map((r) => r.id), ["id-3", "id-4", "id-5"]);
  assert.deepEqual(data.breakdown, { httpErrors: 2, networkErrors: 1 });
  const net = data.requests.find((r) => r.id === "id-5");
  assert.equal(net.failureType, "network_error");
  assert.match(net.error, /ENOTFOUND/);
  const http = data.requests.find((r) => r.id === "id-3");
  assert.equal(http.failureType, "http_error");
  assert.equal(http.status, 500);
});

test("get_failed_requests supports filters and ignores pending/3xx", async () => {
  const entries = makeEntries();
  entries.push({ id: "redirect", method: "GET", url: "https://api.example.com/r", status: 302, duration: 5, startedAt: T0 + 20000 });
  const client = await connect(entries);
  assert.deepEqual((await call(client, "get_failed_requests", { status: "5xx" })).data.requests.map((r) => r.id), ["id-3"]);
  assert.deepEqual((await call(client, "get_failed_requests", { method: "POST" })).data.requests.map((r) => r.id), ["id-3"]);
  const all = (await call(client, "get_failed_requests")).data;
  assert.ok(!all.requests.some((r) => r.id === "redirect" || r.id === "id-7"));
  const paged = (await call(client, "get_failed_requests", { limit: 1 })).data;
  assert.equal(paged.hasMore, true);
});

// --- slow ------------------------------------------------------------------

test("get_slow_requests sorts by duration and honours threshold", async () => {
  const client = await connect(makeEntries());
  const def = (await call(client, "get_slow_requests")).data;
  assert.equal(def.thresholdMs, 1000);
  assert.deepEqual(def.requests.map((r) => r.id), ["id-6", "id-3"]);
  const low = (await call(client, "get_slow_requests", { threshold_ms: 100 })).data;
  assert.deepEqual(low.requests.map((r) => r.id), ["id-6", "id-3", "id-4", "id-1"]);
  const durations = low.requests.map((r) => r.durationMs);
  assert.deepEqual(durations, [...durations].sort((a, b) => b - a));
  assert.ok(!low.requests.some((r) => r.id === "id-7"), "pending has no duration");
  const none = (await call(client, "get_slow_requests", { threshold_ms: 99999 })).data;
  assert.equal(none.totalMatched, 0);
  const lim = (await call(client, "get_slow_requests", { threshold_ms: 0, limit: 2 })).data;
  assert.equal(lim.returned, 2);
  assert.equal(lim.hasMore, true);
});

// --- details ---------------------------------------------------------------

test("get_request_details returns details with redacted headers and hidden body", async () => {
  const client = await connect(makeEntries());
  const { data } = await call(client, "get_request_details", { id: "id-3" });
  assert.equal(data.status, 500);
  assert.equal(data.requestHeaders.Authorization, "[REDACTED]");
  assert.equal(data.requestHeaders.Cookie, "[REDACTED]");
  assert.equal(data.requestHeaders["X-Api-Key"], "[REDACTED]");
  assert.equal(data.requestHeaders["Content-Type"], "application/json");
  assert.equal(data.responseHeaders["set-cookie"], "[REDACTED]");
  assert.equal(data.requestBody.present, true);
  assert.equal(data.requestBody.content, undefined);
});

test("get_request_details exposes redacted bodies only with includeBodies", async () => {
  const client = await connect(makeEntries(), { includeBodies: true });
  const { data } = await call(client, "get_request_details", { id: "id-3" });
  assert.ok(data.requestBody.content.includes("book"));
  assert.ok(!data.requestBody.content.includes("hunter2"));
});

test("get_request_details with missing id returns a clear tool error", async () => {
  const client = await connect(makeEntries());
  const r = await call(client, "get_request_details", { id: "does-not-exist" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No captured request with id/);
});

// --- analyze ---------------------------------------------------------------

test("analyze_network_activity returns structured statistics", async () => {
  const client = await connect(makeEntries());
  const { data } = await call(client, "analyze_network_activity");
  assert.equal(data.totalRequests, 10);
  assert.equal(data.pending, 1);
  assert.equal(data.completed, 8);
  assert.deepEqual(
    { ...data.failedRequests, failureRate: undefined },
    { total: 3, httpErrors: 2, networkErrors: 1, failureRate: undefined },
  );
  assert.equal(data.failedRequests.failureRate, 0.3);
  assert.equal(data.statusCodeDistribution["200"], 6);
  assert.equal(data.statusCodeDistribution["500"], 1);
  assert.equal(data.statusClassDistribution["2xx"], 6);
  assert.equal(data.statusClassDistribution.error, 1);
  assert.equal(data.statusClassDistribution.pending, 1);
  assert.equal(data.methodDistribution.POST, 1);
  assert.equal(data.duration.measuredRequests, 9);
  assert.equal(data.duration.maxMs, 4000);
  assert.equal(data.duration.minMs, 10);
  // (120+80+2500+300+50+4000+10+12+14) / 9
  assert.equal(data.duration.averageMs, 787.33);
  assert.equal(data.slowestEndpoints[0].endpoint, "GET https://api.example.com/slow");
  assert.equal(data.mostFrequentEndpoints[0].endpoint, "GET https://api.example.com/health");
  assert.equal(data.mostFrequentEndpoints[0].count, 3);
  // users/1 and users/2 are grouped as :id
  const users = data.mostFrequentEndpoints.find((e) => e.endpoint.endsWith("/users/:id"));
  assert.equal(users.count, 2);
  assert.deepEqual(data.repeatedIdenticalRequests, [{ request: "GET https://api.example.com/health", count: 3 }]);
  assert.equal(data.endpointsWithMostFailures.length, 3);
  assert.ok(data.timeRange.first < data.timeRange.last);
});

test("analyze_network_activity honours time window and top_n", async () => {
  const client = await connect(makeEntries());
  const win = (await call(client, "analyze_network_activity", { since: T0 + 8000 })).data;
  assert.equal(win.totalRequests, 3);
  const top = (await call(client, "analyze_network_activity", { top_n: 1 })).data;
  assert.equal(top.slowestEndpoints.length, 1);
  assert.equal(top.mostFrequentEndpoints.length, 1);
});

// --- redaction across every tool -------------------------------------------

test("no tool output ever contains a secret from the fixtures", async () => {
  const client = await connect(makeEntries(), { includeBodies: true });
  const outputs = [];
  for (const name of ["get_requests", "get_failed_requests", "get_slow_requests", "analyze_network_activity"]) {
    outputs.push((await call(client, name, name === "get_slow_requests" ? { threshold_ms: 0 } : {})).text);
  }
  for (let i = 1; i <= 10; i++) {
    outputs.push((await call(client, "get_request_details", { id: `id-${i}` })).text);
  }
  const blob = outputs.join("\n");
  for (const secret of SECRETS) {
    assert.ok(!blob.includes(secret), `leaked: ${secret}`);
  }
  assert.ok(blob.includes("[REDACTED]"));
});

test("url_contains cannot be used to probe redacted query secrets", async () => {
  const client = await connect(makeEntries());
  const { data } = await call(client, "get_requests", { url_contains: "QUERYSECRET42" });
  assert.equal(data.totalMatched, 0);
});

// --- invalid arguments -----------------------------------------------------

test("invalid arguments are rejected with errors, never crashes", async () => {
  const client = await connect(makeEntries());
  const bad = [
    ["get_requests", { limit: 0 }],
    ["get_requests", { limit: 100000 }],
    ["get_requests", { limit: 1.5 }],
    ["get_requests", { offset: -1 }],
    ["get_requests", { method: "TELEPORT" }],
    ["get_requests", { status: "banana" }],
    ["get_requests", { status: 99 }],
    ["get_requests", { since: "not a date" }],
    ["get_requests", { url_contains: "" }],
    ["get_requests", { order: "sideways" }],
    ["get_failed_requests", { limit: "ten" }],
    ["get_slow_requests", { threshold_ms: -5 }],
    ["get_slow_requests", { threshold_ms: "slow" }],
    ["get_request_details", {}],
    ["get_request_details", { id: "" }],
    ["get_request_details", { id: 123 }],
    ["get_request_details", { id: "x".repeat(500) }],
    ["analyze_network_activity", { top_n: 0 }],
    ["analyze_network_activity", { top_n: 1000 }],
    ["analyze_network_activity", { until: "yesterday-ish" }],
  ];
  for (const [name, args] of bad) {
    const r = await call(client, name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)} should be rejected`);
  }
  // the server is still healthy afterwards
  assert.equal((await call(client, "get_requests")).isError, false);
});

test("since later than until is a clear error", async () => {
  const client = await connect(makeEntries());
  const r = await call(client, "get_requests", { since: T0 + 5000, until: T0 + 1000 });
  assert.equal(r.isError, true);
  assert.match(r.text, /since/);
});

test("unknown tools are rejected", async () => {
  const client = await connect(makeEntries());
  const r = await call(client, "execute_command", { command: "rm -rf /" });
  assert.equal(r.isError, true);
});

test("unreachable NetSpy produces an actionable tool error", async () => {
  const client = await connect(() => {
    throw new SourceError("No running NetSpy found. Start your app with `netspy <your dev command>` first.");
  });
  const r = await call(client, "get_requests");
  assert.equal(r.isError, true);
  assert.match(r.text, /netspy/i);
});

test("unexpected internal errors do not leak details", async () => {
  const client = await connect(() => {
    throw new Error("/secret/internal/path exploded");
  });
  const r = await call(client, "get_requests");
  assert.equal(r.isError, true);
  assert.ok(!r.text.includes("/secret/internal/path"));
});
