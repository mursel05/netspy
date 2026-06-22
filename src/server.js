import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_HTML_PATH = path.join(__dirname, "public", "panel.html");
const MAX_ENTRIES = 1000;
const entries = [];
const entryIndexById = new Map();

const clients = new Set();

function upsertEntry(payload) {
  if (payload.phase === "start") {
    const entry = { ...payload, status: "pending" };
    entries.push(entry);
    entryIndexById.set(entry.id, entries.length - 1);
    if (entries.length > MAX_ENTRIES) {
      const removed = entries.shift();
      entryIndexById.delete(removed.id);
      entryIndexById.clear();
      entries.forEach((e, i) => entryIndexById.set(e.id, i));
    }
    return entry;
  }

  const idx = entryIndexById.get(payload.id);
  if (idx === undefined) {
    entries.push(payload);
    entryIndexById.set(payload.id, entries.length - 1);
    return payload;
  }
  entries[idx] = { ...entries[idx], ...payload };
  return entries[idx];
}

function broadcast(entry) {
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of clients) {
    res.write(data);
  }
}

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function handleReport(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on("end", () => {
    try {
      const payload = JSON.parse(body);
      const entry = upsertEntry(payload);
      broadcast(entry);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err) });
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

  for (const entry of entries) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  clients.add(res);
  req.on("close", () => clients.delete(res));
}

async function handlePanel(res) {
  try {
    const html = await readFile(PANEL_HTML_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Failed to load panel: ${err.message}`);
  }
}

async function clearEntries() {
  entries.length = 0;
  entryIndexById.clear();
}

export function startServer(port) {
  const server = http.createServer((req, res) => {
    const url = req.url || "/";

    if (req.method === "POST" && url === "/__report") {
      return handleReport(req, res);
    }
    if (req.method === "GET" && url === "/__stream") {
      return handleStream(req, res);
    }
    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      return handlePanel(res);
    }
    if (req.method === "GET" && url === "/__entries") {
      return sendJson(res, 200, entries);
    }
    if (req.method === "POST" && url === "/__clear") {
      return clearEntries();
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}
