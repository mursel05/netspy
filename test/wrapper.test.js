// End-to-end tests for `netspy <command>`: the interceptor, argument handling,
// signal forwarding and the browser opener, using real child processes.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stopTree } from "./helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "netspy.js");
const NODE = process.execPath;

let target, targetPort, dir;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for condition");
}

function runNetspy(args, { env = {} } = {}) {
  const child = spawn(NODE, [BIN, ...args], {
    env: { ...process.env, TARGET_PORT: String(targetPort), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  child.stdout.on("data", (d) => (child.output += d));
  child.stderr.on("data", (d) => (child.output += d));
  child.exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
  return child;
}

const entriesOf = async (port) => (await fetch(`http://127.0.0.1:${port}/__entries`)).json();

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  target = http.createServer((req, res) => {
    res.setHeader("X-Custom", "yes");
    res.end("ok");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  targetPort = target.address().port;
  dir = mkdtempSync(path.join(tmpdir(), "netspy-wrapper-"));

  writeFileSync(
    path.join(dir, "app.cjs"),
    `
const http = require("node:http");
const fs = require("node:fs");
const base = "http://127.0.0.1:" + process.env.TARGET_PORT;
fs.writeFileSync(process.env.OUT_FILE, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid, port: process.env.PORT }));
(async () => {
  await fetch(base + "/headers", { headers: new Headers({ "X-Req": "1" }) });
  await fetch(new Request(base + "/request-obj", { method: "PUT", headers: { "X-From": "request" } }));
  await fetch(base + "/buffer", { method: "POST", body: Buffer.alloc(2048) });
  await fetch(base + "/form", { method: "POST", body: new URLSearchParams({ a: "1" }) });
  await Promise.all(Array.from({ length: 40 }, (_, i) => fetch(base + "/burst/" + i)));
  await new Promise((resolve) => require("node:https").get("https://127.0.0.1:1/x").on("error", resolve));
  fs.writeFileSync(process.env.OUT_FILE + ".done", "1");
  setInterval(() => {}, 1000);
})();
`,
  );
});

after(async () => {
  await new Promise((r) => target.close(r));
  rmSync(dir, { recursive: true, force: true });
});

test("captures fetch/http headers and bodies correctly, with no stuck duplicates", async () => {
  const port = await freePort();
  const out = path.join(dir, "out1.json");
  const ns = runNetspy(["--no-open", "-p", String(port), NODE, path.join(dir, "app.cjs")], {
    env: { OUT_FILE: out },
  });
  try {
    await waitFor(() => existsSync(out + ".done"));
    const entries = await waitFor(async () => {
      const e = await entriesOf(port);
      return e.length >= 45 && e.every((x) => x.status !== "pending") ? e : null;
    });

    assert.equal(entries.length, 45, "one entry per request");
    assert.equal(new Set(entries.map((e) => e.id)).size, 45);

    const h = entries.find((e) => e.url.endsWith("/headers"));
    assert.equal(h.requestHeader["x-req"], "1");
    assert.equal(h.responseHeader["x-custom"], "yes");

    const r = entries.find((e) => e.url.endsWith("/request-obj"));
    assert.equal(r.method, "PUT");
    assert.equal(r.requestHeader["x-from"], "request");

    assert.equal(entries.find((e) => e.url.endsWith("/buffer")).body, "[binary body, 2048 bytes]");
    assert.equal(entries.find((e) => e.url.endsWith("/form")).body, "a=1");

    const https = entries.find((e) => e.url.startsWith("https://127.0.0.1:1/"));
    assert.equal(https.via, "https");
    assert.equal(https.status, "error");
  } finally {
    stopTree(ns);
    await ns.exited;
  }
});

test("flags after the command and arguments with spaces reach the command", async () => {
  const port = await freePort();
  const out = path.join(dir, "out2.json");
  const ns = runNetspy(
    ["--no-open", "-p", String(port), "PORT=3123", NODE, path.join(dir, "app.cjs"), "hello world", "-p", "3001"],
    { env: { OUT_FILE: out } },
  );
  try {
    const info = await waitFor(() => existsSync(out) && JSON.parse(readFileSync(out, "utf8")));
    assert.deepEqual(info.argv, ["hello world", "-p", "3001"]);
    assert.equal(info.port, "3123");
    assert.match(ns.output, new RegExp(`127\\.0\\.0\\.1:${port}`), "panel used NetSpy's own port");
  } finally {
    stopTree(ns);
    await ns.exited;
  }
});

test("SIGTERM stops the wrapped process too (no orphans) and exits 143", { skip: process.platform === "win32" && "no POSIX signals on Windows" }, async () => {
  const port = await freePort();
  const out = path.join(dir, "out3.json");
  const ns = runNetspy(["--no-open", "-p", String(port), NODE, path.join(dir, "app.cjs")], {
    env: { OUT_FILE: out },
  });
  const info = await waitFor(() => existsSync(out) && JSON.parse(readFileSync(out, "utf8")));
  assert.ok(isAlive(info.pid));
  ns.kill("SIGTERM");
  const { code } = await ns.exited;
  assert.equal(code, 143);
  await waitFor(() => !isAlive(info.pid), 3000);
});

test("a missing browser opener does not crash NetSpy", { skip: process.platform === "win32" }, async () => {
  const port = await freePort();
  const out = path.join(dir, "out4.json");
  // Empty PATH: xdg-open/open cannot be found. The command is an absolute path.
  const ns = runNetspy(["-p", String(port), NODE, path.join(dir, "app.cjs")], {
    env: { OUT_FILE: out, PATH: path.join(dir, "empty-path") },
  });
  try {
    await waitFor(() => existsSync(out + ".done"));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(ns.exitCode, null, `netspy exited early:\n${ns.output}`);
  } finally {
    stopTree(ns);
    await ns.exited;
  }
});

test("unknown commands fail with exit code 127 and a clear message", async () => {
  const ns = runNetspy(["--no-open", "-p", String(await freePort()), "definitely-not-a-command-xyz", "arg"]);
  const { code } = await ns.exited;
  if (process.platform === "win32") {
    // Windows runs commands through cmd.exe, which reports this itself.
    assert.notEqual(code, 0);
    return;
  }
  assert.equal(code, 127);
  assert.match(ns.output, /command not found: definitely-not-a-command-xyz/);
});

test("--version and --help work without a command", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const v = runNetspy(["--version"]);
  assert.equal((await v.exited).code, 0);
  assert.equal(v.output.trim(), pkg.version);
  const h = runNetspy(["--help"]);
  assert.equal((await h.exited).code, 0);
  assert.match(h.output, /Usage: netspy/);
});
