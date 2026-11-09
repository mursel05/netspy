import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHttpSource, SourceError } from "../src/mcp/source.js";
import { startServer } from "../src/server.js";

test("source reads entries from a real NetSpy panel server", async () => {
  const server = await startServer(0);
  const { port } = server.address();
  try {
    await fetch(`http://127.0.0.1:${port}/__report`, {
      method: "POST",
      body: JSON.stringify({ id: "a", url: "https://x.test/", method: "GET", phase: "start", startedAt: 1 }),
    });
    await fetch(`http://127.0.0.1:${port}/__report`, {
      method: "POST",
      body: JSON.stringify({ id: "a", phase: "end", status: 200, duration: 5 }),
    });
    const entries = await createHttpSource({ port }).getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 200);
  } finally {
    server.close();
  }
});

test("source gives an actionable error when nothing listens", async () => {
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  await assert.rejects(createHttpSource({ port }).getEntries(), (err) => {
    assert.ok(err instanceof SourceError);
    assert.match(err.message, /netspy/i);
    return true;
  });
});

test("source rejects non-NetSpy servers (wrong JSON shape)", async () => {
  const other = http.createServer((req, res) => res.end('{"hello":"world"}'));
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(createHttpSource({ port: other.address().port }).getEntries(), SourceError);
  } finally {
    other.close();
  }
});
