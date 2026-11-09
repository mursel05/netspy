import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";

export const T0 = Date.parse("2026-01-01T00:00:00.000Z");

export const SECRETS = [
  "Bearer sk-live-SUPERSECRET",
  "sk-live-SUPERSECRET",
  "session=abc123cookie",
  "abc123cookie",
  "KEY-IN-HEADER-999",
  "hunter2",
  "QUERYSECRET42",
  "urlpass",
  "setcookie-secret-777",
];

let n = 0;
function entry(overrides) {
  n += 1;
  return {
    id: `id-${n}`,
    method: "GET",
    url: "https://api.example.com/",
    startedAt: T0 + n * 1000,
    status: 200,
    statusText: "OK",
    ok: true,
    duration: 100,
    phase: "end",
    ...overrides,
  };
}

/** Fresh fixture set with stable ids (id-1 ... id-N). */
export function makeEntries() {
  n = 0;
  return [
    entry({ url: "https://api.example.com/users/1", duration: 120 }),
    entry({ url: "https://api.example.com/users/2", duration: 80 }),
    entry({
      method: "POST",
      url: "https://api.example.com/orders",
      status: 500,
      statusText: "Internal Server Error",
      ok: false,
      duration: 2500,
      requestHeader: {
        Authorization: "Bearer sk-live-SUPERSECRET",
        Cookie: "session=abc123cookie",
        "X-Api-Key": "KEY-IN-HEADER-999",
        "Content-Type": "application/json",
      },
      responseHeader: {
        "set-cookie": "setcookie-secret-777",
        "content-type": "application/json",
      },
      body: JSON.stringify({ item: "book", password: "hunter2" }),
    }),
    entry({
      url: "https://api.example.com/products?page=2&api_key=QUERYSECRET42",
      status: 404,
      statusText: "Not Found",
      ok: false,
      duration: 300,
      // array-of-pairs header shape
      requestHeader: [["authorization", "Bearer sk-live-SUPERSECRET"], ["accept", "*/*"]],
    }),
    entry({
      url: "https://down.example.com/",
      status: "error",
      ok: undefined,
      statusText: undefined,
      error: "getaddrinfo ENOTFOUND down.example.com",
      duration: 50,
    }),
    entry({ url: "https://user:urlpass@api.example.com/slow", duration: 4000 }),
    entry({ url: "https://api.example.com/pending", status: "pending", duration: undefined, ok: undefined }),
    entry({ url: "https://api.example.com/health", duration: 10 }),
    entry({ url: "https://api.example.com/health", duration: 12 }),
    entry({ url: "https://api.example.com/health", duration: 14 }),
  ];
}

export async function connect(entries, options) {
  const source = {
    getEntries: async () => (typeof entries === "function" ? entries() : entries),
  };
  const server = createMcpServer(source, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Calls a tool; never throws. Returns { isError, text, data }. */
export async function call(client, name, args = {}) {
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    let data = null;
    if (!res.isError) data = JSON.parse(text);
    return { isError: Boolean(res.isError), text, data, structured: res.structuredContent };
  } catch (err) {
    // Some SDK versions surface validation failures as protocol errors.
    return { isError: true, text: String(err.message), data: null };
  }
}
