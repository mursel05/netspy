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
  try {
    if (options && options.method) return String(options.method).toUpperCase();
    if (resource && typeof resource === "object" && resource.method) {
      return String(resource.method).toUpperCase();
    }
  } catch {}
  return "GET";
}

/**
 * Turns any header shape (Headers instance, array of pairs, plain object,
 * Node's IncomingHttpHeaders) into a plain JSON-safe object. JSON.stringify
 * on a Headers instance yields {}, which is why this is needed.
 */
function serializeHeaders(headers) {
  try {
    if (!headers) return undefined;
    if (typeof headers.forEach === "function" && typeof headers.get === "function") {
      const out = {};
      headers.forEach((value, name) => {
        out[name] = value;
      });
      return out;
    }
    if (Array.isArray(headers)) {
      const out = {};
      for (const pair of headers) {
        if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
      }
      return out;
    }
    if (typeof headers === "object") {
      const out = {};
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        out[name] = Array.isArray(value) ? value.map(String).join(", ") : String(value);
      }
      return out;
    }
  } catch {}
  return undefined;
}

const MAX_BODY_CHARS = 64 * 1024;

/**
 * Describes a request body as a string the panel can show. Binary bodies,
 * streams and form data are summarised instead of being serialised byte by
 * byte, and long text is truncated so a report never exceeds the panel's
 * size limit.
 */
function serializeBody(body) {
  try {
    if (body === undefined || body === null) return undefined;
    let text;
    if (typeof body === "string") text = body;
    else if (body instanceof URLSearchParams) text = body.toString();
    else if (Buffer.isBuffer(body) || ArrayBuffer.isView(body)) {
      return `[binary body, ${body.byteLength} bytes]`;
    } else if (body instanceof ArrayBuffer) {
      return `[binary body, ${body.byteLength} bytes]`;
    } else if (typeof Blob !== "undefined" && body instanceof Blob) {
      return `[Blob, ${body.size} bytes]`;
    } else if (typeof FormData !== "undefined" && body instanceof FormData) {
      const fields = [];
      body.forEach((value, key) => {
        fields.push(typeof value === "string" ? `${key}=${value}` : `${key}=[file]`);
      });
      text = fields.join("&");
    } else if (typeof body.getReader === "function" || typeof body.pipe === "function") {
      return "[stream body]";
    } else {
      text = String(body);
    }
    return text.length > MAX_BODY_CHARS
      ? `${text.slice(0, MAX_BODY_CHARS)}… [truncated, ${text.length} chars]`
      : text;
  } catch {
    return "[unreadable body]";
  }
}

function requestHeadersFor(resource, options) {
  if (options && options.headers) return serializeHeaders(options.headers);
  if (resource && typeof resource === "object" && resource.headers) {
    return serializeHeaders(resource.headers);
  }
  return undefined;
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
      requestHeader: requestHeadersFor(resource, options),
      body: serializeBody(options?.body),
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
        responseHeader: serializeHeaders(response?.headers),
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
    if (urlArg) {
      const u = new URL(String(urlArg));
      // http.request(url, options): options override parts of the URL.
      if (optionsArg && optionsArg.path) {
        return new URL(optionsArg.path, u.origin).toString();
      }
      return u.toString();
    }
    if (optionsArg) {
      let host = optionsArg.hostname || optionsArg.host || "localhost";
      if (!optionsArg.hostname && typeof optionsArg.host === "string") {
        // `host` may carry a port ("example.com:8080").
        host = optionsArg.host.replace(/:\d+$/, "");
      }
      if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
      const protocol = String(optionsArg.protocol || `${scheme}:`).replace(/:$/, "");
      const defaultPort = protocol === "https" ? 443 : 80;
      const port =
        optionsArg.port && Number(optionsArg.port) !== defaultPort
          ? `:${optionsArg.port}`
          : "";
      const path = optionsArg.path || "/";
      return `${protocol}://${host}${port}${path}`;
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
        host = optionsArg?.hostname || String(optionsArg?.host || "").replace(/:\d+$/, "");
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
      requestHeader: serializeHeaders(optionsArg?.headers),
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
        responseHeader: serializeHeaders(res?.headers),
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
      // Our listener must not change the app's behaviour: without NetSpy an
      // unhandled request error throws, so keep throwing when nobody else
      // listens for it.
      if (req.listenerCount("error") === 1) throw err;
    });

    return req;
  }
  mod.request = function patchedRequest(...args) {
    return instrument(originalRequest, args, scheme);
  };
  mod.get = function patchedGet(...args) {
    return instrument(originalGet, args, scheme);
  };
}

patchRequestModule(nodeHttp, "http");
patchRequestModule(nodeHttps, "https");
