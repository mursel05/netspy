// Reads captured entries from a running NetSpy panel server via its existing
// `GET /__entries` endpoint. The MCP process is a separate process from the
// `netspy <command>` process, so this is the only data path: the MCP server
// never touches the interceptor, never makes arbitrary HTTP requests, and
// only ever talks to 127.0.0.1 on a NetSpy port.

import http from "node:http";

const HOST = "127.0.0.1";
export const DEFAULT_PORT = 4000;
export const PORT_SCAN_RANGE = 20; // matches bin/netspy.js MAX_PORT_ATTEMPTS
const REQUEST_TIMEOUT_MS = 1500;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

export class SourceError extends Error {}

function getJson(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: HOST, port, path: "/__entries", timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`unexpected status ${res.statusCode}`));
        }
        let size = 0;
        const chunks = [];
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!Array.isArray(data)) throw new Error("not a NetSpy entries list");
            resolve(data);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

/**
 * @param {{ port?: number }} [options] Pin a port, or omit to auto-discover
 *   a running NetSpy panel on ports 4000-4019.
 */
export function createHttpSource({ port } = {}) {
  let discovered = port;

  async function discover() {
    const candidates = Array.from({ length: PORT_SCAN_RANGE }, (_, i) => DEFAULT_PORT + i);
    const results = await Promise.all(
      candidates.map((p) =>
        getJson(p).then(
          () => p,
          () => null,
        ),
      ),
    );
    return results.find((p) => p !== null) ?? null;
  }

  return {
    async getEntries() {
      if (discovered === undefined) {
        discovered = await discover();
        if (discovered === null) {
          discovered = undefined;
          throw new SourceError(
            `No running NetSpy found on ports ${DEFAULT_PORT}-${DEFAULT_PORT + PORT_SCAN_RANGE - 1}. ` +
              "Start your app with `netspy <your dev command>` first (or pass --port to `netspy mcp`).",
          );
        }
      }
      const usedPort = discovered;
      try {
        return await getJson(usedPort);
      } catch (err) {
        if (port === undefined) discovered = undefined; // re-discover next call
        throw new SourceError(
          `Could not read captured requests from NetSpy on port ${usedPort} (${err.message}). ` +
            "Is `netspy <your dev command>` still running?",
        );
      }
    },
  };
}
