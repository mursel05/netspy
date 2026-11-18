import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_HTML_PATH = path.join(__dirname, "public", "panel.html");
const HOST = "127.0.0.1";
export const MAX_ENTRIES = 1000;
const MAX_REPORT_BYTES = 1_000_000;
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * In-memory store of captured requests, keyed by id. Map keeps insertion
 * order, so the oldest entry is always first and trimming is O(1).
 */
export function createStore(maxEntries = MAX_ENTRIES) {
  const entries = new Map();

  function trim() {
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  return {
    /**
     * "start" and "end" reports travel over separate HTTP requests and can
     * arrive in either order, so both phases merge into one entry and a late
     * "start" never overwrites the final status of a fast request.
     */
    upsert(payload) {
      const existing = entries.get(payload.id);
      let entry;
      if (payload.phase === "start") {
        entry = existing
          ? { ...payload, ...existing }
          : { ...payload, status: "pending" };
      } else {
        entry = existing ? { ...existing, ...payload } : { ...payload };
      }
      entries.set(payload.id, entry);
      trim();
      return entry;
    },
    list() {
      return [...entries.values()];
    },
    clear() {
      entries.clear();
    },
  };
}

const store = createStore();
const clients = new Set();

function sse(res, data, event) {
  res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(data, event) {
  for (const res of clients) sse(res, data, event);
}

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function isValidReport(payload) {
  return (
    payload !== null &&
    typeof payload === "object" &&
    typeof payload.id === "string" &&
    payload.id.length > 0 &&
    payload.id.length <= 128
  );
}

function handleReport(req, res) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > MAX_REPORT_BYTES) {
      tooLarge = true;
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (tooLarge) return sendJson(res, 413, { ok: false, error: "report too large" });
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isValidReport(payload)) throw new Error("invalid report");
      broadcast(store.upsert(payload));
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err.message || err) });
    }
  });
}

function handleStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`retry: 1000\n\n`);
  // Tell the panel to drop its state first, so a reconnect after a NetSpy
  // restart (or a clear from another tab) never shows stale rows.
  sse(res, {}, "reset");
  for (const entry of store.list()) sse(res, entry);

  clients.add(res);
  req.on("close", () => clients.delete(res));
}

async function handlePanel(res) {
  try {
    const html = await readFile(PANEL_HTML_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Failed to load panel: ${err.message}`);
  }
}

/**
 * Only answer requests addressed to localhost. Blocks DNS-rebinding attacks
 * where a web page tricks the browser into reading captured headers.
 */
function isAllowedHost(hostHeader) {
  if (!hostHeader) return false;
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : hostHeader.split(":")[0];
  return ALLOWED_HOSTNAMES.has(hostname.toLowerCase());
}

export function startServer(port) {
  const server = http.createServer((req, res) => {
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden");
    }

    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {}

    if (req.method === "POST" && pathname === "/__report") {
      return handleReport(req, res);
    }
    if (req.method === "GET" && pathname === "/__stream") {
      return handleStream(req, res);
    }
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return handlePanel(res);
    }
    if (req.method === "GET" && pathname === "/__entries") {
      return sendJson(res, 200, store.list());
    }
    if (req.method === "POST" && pathname === "/__clear") {
      store.clear();
      broadcast({}, "reset");
      res.writeHead(204);
      return res.end();
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: captured traffic contains auth headers and cookies and
    // must not be reachable from the local network.
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
