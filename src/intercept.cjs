"use strict";

const REPORT_PORT = process.env.NETSPY_PORT;
const REPORT_HOST = "127.0.0.1";

if (!REPORT_PORT) {
  return;
}

if (globalThis.__ssrNetworkPatched) {
  return;
}
globalThis.__ssrNetworkPatched = true;

const originalFetch = globalThis.fetch;

if (typeof originalFetch !== "function") {
  return;
}

const http = require("node:http");
const { randomUUID } = require("node:crypto");

function report(entry) {
  try {
    const body = JSON.stringify(entry);
    const req = http.request(
      {
        host: REPORT_HOST,
        port: REPORT_PORT,
        path: "/__report",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 1000,
      },
      (res) => {
        res.resume();
      },
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.write(body);
    req.end();
  } catch {}
}

function safeUrl(resource) {
  try {
    if (typeof resource === "string") return resource;
    if (resource instanceof URL) return resource.toString();
    if (resource && typeof resource.url === "string") return resource.url;
    return String(resource);
  } catch {
    return "unknown";
  }
}

function safeMethod(resource, options) {
  if (options && options.method) return options.method.toUpperCase();
  if (resource && typeof resource === "object" && resource.method) {
    return resource.method.toUpperCase();
  }
  return "GET";
}

globalThis.fetch = async function patchedFetch(resource, options) {
  const id = randomUUID();
  const url = safeUrl(resource);
  const method = safeMethod(resource, options);
  const startedAt = Date.now();
  const start = performance.now();

  report({
    id,
    url,
    method,
    startedAt,
    status: "pending",
    phase: "start",
    requestHeader: options?.headers,
    body: options?.body,
  });

  try {
    const response = await originalFetch(resource, options);
    report({
      id,
      url,
      method,
      startedAt,
      phase: "end",
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      duration: performance.now() - start,
      responseHeader: response?.headers,
    });
    return response;
  } catch (err) {
    report({
      id,
      url,
      method,
      startedAt,
      phase: "end",
      status: "error",
      error: err && err.message ? err.message : String(err),
      duration: performance.now() - start,
    });
    throw err;
  }
};
