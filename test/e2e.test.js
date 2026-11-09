// End-to-end: real `netspy <command>` (interceptor + panel server) wrapping a
// script that makes real requests, and a real `netspy mcp` stdio process
// talking to it through an MCP client.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SECRETS } from "./helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "netspy.js");

let target, targetPort, panelPort, netspy, client, scriptDir;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for condition");
}

const wrappedScript = `
const http = require("node:http");
const base = "http://127.0.0.1:" + process.env.TARGET_PORT;
(async () => {
  await fetch(base + "/users/42", { headers: { Authorization: "Bearer sk-live-SUPERSECRET" } });
  await fetch(base + "/boom?api_key=QUERYSECRET42", {
    method: "POST",
    headers: { Cookie: "session=abc123cookie", "Content-Type": "application/json" },
    body: JSON.stringify({ password: "hunter2" }),
  });
  await fetch(base + "/slow");
  await new Promise((resolve) => http.get(base + "/users/43", (res) => { res.resume(); res.on("end", resolve); }));
  await fetch("http://127.0.0.1:1/unreachable").catch(() => {});
  setInterval(() => {}, 1000);
})();
`;

before(async () => {
  target = http.createServer((req, res) => {
    if (req.url.startsWith("/boom")) {
      res.writeHead(500, { "Set-Cookie": "setcookie-secret-777" });
      return res.end("boom");
    }
    if (req.url === "/slow") return setTimeout(() => res.end("slow"), 350);
    res.end("ok");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  targetPort = target.address().port;
  panelPort = await freePort();

  // netspy runs the wrapped command through a shell without re-quoting its
  // arguments, so keep the command simple: `node <file>`.
  scriptDir = mkdtempSync(path.join(tmpdir(), "netspy-e2e-"));
  const scriptPath = path.join(scriptDir, "app.cjs");
  writeFileSync(scriptPath, wrappedScript);
  netspy = spawn(process.execPath, [BIN, "-p", String(panelPort), "node", JSON.stringify(scriptPath)], {
    env: { ...process.env, TARGET_PORT: String(targetPort) },
    stdio: ["ignore", "ignore", "inherit"],
  });

  // Wait until the wrapped process has reported all 5 requests as finished.
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${panelPort}/__entries`);
    const entries = await res.json();
    return entries.filter((e) => e.status !== "pending").length >= 5;
  });

  client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "mcp", "--port", String(panelPort)],
      stderr: "ignore",
    }),
  );
});

after(async () => {
  await client?.close().catch(() => {});
  netspy?.kill("SIGTERM");
  await new Promise((r) => target?.close(r));
  if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
});

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { ...res, data: res.isError ? null : JSON.parse(res.content[0].text), text: res.content[0].text };
};

test("e2e: stdio MCP server exposes the five tools", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 5);
});

test("e2e: get_requests returns real captured fetch and http requests", async () => {
  const { data } = await call("get_requests", { order: "asc" });
  assert.equal(data.totalMatched, 5);
  const urls = data.requests.map((r) => r.url);
  assert.ok(urls.some((u) => u.endsWith("/users/42")));
  assert.ok(urls.some((u) => u.endsWith("/users/43")), "http module request captured");
  assert.ok(data.requests.some((r) => r.via === "http"));
});

test("e2e: failed, slow, details and analysis work on real data", async () => {
  const failed = (await call("get_failed_requests")).data;
  assert.deepEqual(failed.breakdown, { httpErrors: 1, networkErrors: 1 });

  const slow = (await call("get_slow_requests", { threshold_ms: 300 })).data;
  assert.equal(slow.requests[0].url.endsWith("/slow"), true);

  const post = (await call("get_requests", { method: "POST" })).data.requests[0];
  assert.equal(post.status, 500);
  const details = (await call("get_request_details", { id: post.id })).data;
  assert.equal(details.requestHeaders.Cookie, "[REDACTED]");
  assert.equal(details.requestBody.content, undefined);

  const stats = (await call("analyze_network_activity")).data;
  assert.equal(stats.totalRequests, 5);
  assert.equal(stats.failedRequests.total, 2);
  assert.ok(stats.mostFrequentEndpoints.some((e) => e.endpoint.endsWith("/users/:id") && e.count === 2));
});

test("e2e: nothing sensitive crosses the MCP boundary", async () => {
  const all = (await call("get_requests")).data.requests;
  const texts = [JSON.stringify(all)];
  for (const r of all) texts.push((await call("get_request_details", { id: r.id })).text);
  texts.push((await call("get_failed_requests")).text, (await call("analyze_network_activity")).text);
  const blob = texts.join("\n");
  for (const secret of SECRETS) assert.ok(!blob.includes(secret), `leaked ${secret}`);
});

test("e2e: missing id returns a tool error over stdio", async () => {
  const r = await call("get_request_details", { id: "nope" });
  assert.equal(r.isError, true);
});
