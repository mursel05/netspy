import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { createStore, startServer } from "../src/server.js";

test("store: an 'end' report that arrives before 'start' is not lost or duplicated", () => {
  const store = createStore();
  store.upsert({ id: "a", phase: "end", status: 200, duration: 5 });
  store.upsert({ id: "a", phase: "start", status: "pending", url: "http://x/", method: "GET" });
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 200);
  assert.equal(list[0].url, "http://x/");
});

test("store: normal start then end", () => {
  const store = createStore();
  store.upsert({ id: "a", phase: "start", url: "http://x/" });
  assert.equal(store.list()[0].status, "pending");
  store.upsert({ id: "a", phase: "end", status: 404 });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].status, 404);
});

test("store: capped, oldest dropped first, for both phases", () => {
  const store = createStore(3);
  for (let i = 0; i < 5; i++) store.upsert({ id: `s${i}`, phase: i % 2 ? "end" : "start" });
  assert.deepEqual(store.list().map((e) => e.id), ["s2", "s3", "s4"]);
});

let server, port;

function request(path, { method = "GET", host, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, timeout: 2000, headers: host ? { Host: host } : {} },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

before(async () => {
  for (port = 41000; ; port++) {
    try {
      server = await startServer(port);
      break;
    } catch {}
  }
});
after(() => {
  server.closeAllConnections?.();
  server.close();
});

test("server: /__clear responds and empties the store", async () => {
  await request("/__report", { method: "POST", body: JSON.stringify({ id: "z", phase: "start" }) });
  assert.equal(JSON.parse((await request("/__entries")).body).length, 1);
  const res = await request("/__clear", { method: "POST" });
  assert.equal(res.status, 204);
  assert.deepEqual(JSON.parse((await request("/__entries")).body), []);
});

test("server: clear and (re)connect send a reset event to the panel", async () => {
  const events = [];
  const req = http.get({ host: "127.0.0.1", port, path: "/__stream" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (c) => events.push(c));
  });
  await new Promise((r) => setTimeout(r, 100));
  await request("/__clear", { method: "POST" });
  await new Promise((r) => setTimeout(r, 100));
  req.destroy();
  const resets = events.join("").match(/event: reset/g) || [];
  assert.equal(resets.length, 2);
});

test("server: invalid and oversized reports are rejected", async () => {
  assert.equal((await request("/__report", { method: "POST", body: "{}" })).status, 400);
  const big = JSON.stringify({ id: "big", body: "x".repeat(1_100_000) });
  assert.equal((await request("/__report", { method: "POST", body: big })).status, 413);
});

test("server: foreign Host headers are refused (DNS rebinding)", async () => {
  assert.equal((await request("/__entries", { host: "evil.example.com" })).status, 403);
  assert.equal((await request("/__entries", { host: `localhost:${port}` })).status, 200);
  assert.equal((await request("/?x=1")).status, 200);
});

test("server: listens on loopback only", async () => {
  const ip = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (!ip) return; // no external interface in this environment
  const reachable = await new Promise((resolve) => {
    const s = net.connect(port, ip);
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });
  assert.equal(reachable, false);
});
