"use strict";

const REPORT_PORT = process.env.NETWRAP_PORT;
const REPORT_HOST = "127.0.0.1";

if (!REPORT_PORT) {
  return;
}

if (globalThis.__ssrNetworkPatched) {
  return;
}
globalThis.__ssrNetworkPatched = true;

const nodeHttp = require("node:http");
const nodeHttps = require("node:https");
const { randomUUID } = require("node:crypto");

const rawHttpRequest = nodeHttp.request.bind(nodeHttp);

function report(entry) {
  try {
    const body = JSON.stringify(entry);
    const req = rawHttpRequest(
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

function isOwnReportingCall(host, port) {
  return host === REPORT_HOST && String(port) === String(REPORT_PORT);
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

const originalFetch = globalThis.fetch;

if (typeof originalFetch === "function") {
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
}

function buildUrlFromArgs(urlArg, optionsArg, scheme) {
  try {
    if (urlArg) return new URL(String(urlArg)).toString();
    if (optionsArg) {
      const host = optionsArg.hostname || optionsArg.host || "localhost";
      const port = optionsArg.port ? `:${optionsArg.port}` : "";
      const path = optionsArg.path || "/";
      return `${scheme}://${host}${port}${path}`;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

function patchRequestModule(mod, scheme) {
  const originalRequest = mod.request.bind(mod);
  const originalGet = mod.get.bind(mod);

  function normalizeArgs(args) {
    let urlArg, optionsArg;
    if (typeof args[0] === "string" || args[0] instanceof URL) {
      urlArg = args[0];
      if (typeof args[1] !== "function") optionsArg = args[1];
    } else {
      optionsArg = args[0];
    }
    return { urlArg, optionsArg };
  }

  function shouldSkip(urlArg, optionsArg) {
    let host, port;
    try {
      if (urlArg) {
        const u = new URL(String(urlArg));
        host = u.hostname;
        port = u.port;
      } else {
        host = optionsArg?.host || optionsArg?.hostname;
        port = optionsArg?.port;
      }
    } catch {}
    return isOwnReportingCall(host, port);
  }

  function instrument(invoke, args, viaLabel) {
    const { urlArg, optionsArg } = normalizeArgs(args);

    if (shouldSkip(urlArg, optionsArg)) {
      return invoke(...args);
    }

    const id = randomUUID();
    const url = buildUrlFromArgs(urlArg, optionsArg, scheme);
    const method = (optionsArg?.method || "GET").toUpperCase();
    const startedAt = Date.now();
    const start = performance.now();

    report({
      id,
      url,
      method,
      startedAt,
      status: "pending",
      phase: "start",
      via: viaLabel,
      requestHeader: optionsArg?.headers,
      body: optionsArg?.body,
    });

    const req = invoke(...args);

    req.on("response", (res) => {
      report({
        id,
        url,
        method,
        startedAt,
        phase: "end",
        via: viaLabel,
        status: res.statusCode,
        statusText: res.statusMessage,
        ok: res.statusCode >= 200 && res.statusCode < 400,
        duration: performance.now() - start,
        responseHeader: res?.headers,
      });
    });

    req.on("error", (err) => {
      report({
        id,
        url,
        method,
        startedAt,
        phase: "end",
        via: viaLabel,
        status: "error",
        error: err && err.message ? err.message : String(err),
        duration: performance.now() - start,
      });
    });

    return req;
  }
  mod.request = function patchedRequest(...args) {
    return instrument(originalRequest, args, "http");
  };
  mod.get = function patchedGet(...args) {
    return instrument(originalGet, args, "http");
  };
}

patchRequestModule(nodeHttp, "http");
patchRequestModule(nodeHttps, "https");
