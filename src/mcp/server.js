// MCP server for NetSpy. Registers five read-only tools that expose captured
// network activity (redacted) to AI agents. Transport-agnostic: bin/netspy.js
// connects it over stdio; tests connect it in-memory.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DEFAULT_LIMIT,
  DEFAULT_SLOW_THRESHOLD_MS,
  DEFAULT_TOP_N,
  InputError,
  MAX_LIMIT,
  MAX_TOP_N,
  analyzeNetworkActivity,
  getFailedRequests,
  getRequestDetails,
  getRequests,
  getSlowRequests,
} from "./queries.js";
import { SourceError } from "./source.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const timeValue = z
  .union([z.string().max(64), z.number()])
  .refine((v) => Number.isFinite(typeof v === "number" ? v : Date.parse(v)), {
    message: "must be an ISO-8601 date string or epoch milliseconds",
  });

const filterShape = {
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    .optional()
    .describe("Only requests with this HTTP method."),
  status: z
    .union([
      z.number().int().min(100).max(599),
      z.string().regex(/^([1-5]xx|[1-5]\d\d|error|pending)$/i),
    ])
    .optional()
    .describe(
      'Exact status code (404), status class ("5xx"), "error" for network errors, or "pending" for in-flight requests.',
    ),
  url_contains: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Case-insensitive substring to look for in the request URL."),
  since: timeValue.optional().describe(
    "Only requests started at or after this time (ISO-8601 string or epoch milliseconds).",
  ),
  until: timeValue.optional().describe(
    "Only requests started at or before this time (ISO-8601 string or epoch milliseconds).",
  ),
};

const pagingShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of results to skip, for pagination. Use nextOffset from the previous response."),
};

const orderShape = {
  order: z
    .enum(["desc", "asc"])
    .optional()
    .describe("Sort by start time: desc = newest first (default), asc = oldest first."),
};

function ok(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function fail(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * @param {{ getEntries: () => Promise<object[]> }} source
 * @param {{ includeBodies?: boolean, version?: string }} [options]
 */
export function createMcpServer(source, { includeBodies = false, version = "0.0.0" } = {}) {
  const server = new McpServer({ name: "netspy", version });

  // Wraps a tool so that expected failures (bad input, NetSpy not running,
  // unknown id) become clean MCP tool errors instead of protocol errors.
  const handler = (fn) => async (args) => {
    try {
      const entries = await source.getEntries();
      return ok(fn(entries, args ?? {}));
    } catch (err) {
      if (err instanceof InputError || err instanceof SourceError) {
        return fail(err.message);
      }
      return fail("Unexpected error while reading NetSpy data.");
    }
  };

  server.registerTool(
    "get_requests",
    {
      title: "Get captured requests",
      description:
        "List server-side HTTP/HTTPS/fetch requests captured by NetSpy from the running dev server. " +
        "Supports filtering by method, status (code, class like 5xx, 'error', 'pending'), URL substring and time range, plus pagination. " +
        "Newest first by default. Returns compact summaries; call get_request_details with an id for headers. " +
        "Credentials are always redacted. Use this to answer questions like 'show me all POST requests to /api/orders'.",
      inputSchema: { ...filterShape, ...orderShape, ...pagingShape },
      annotations: READ_ONLY,
    },
    handler((entries, args) => getRequests(entries, args)),
  );

  server.registerTool(
    "get_failed_requests",
    {
      title: "Get failed requests",
      description:
        "List failed requests: HTTP errors (status >= 400) and network-level errors (DNS failure, connection refused, timeout) with their error messages. " +
        "Each item has failureType 'http_error' or 'network_error'. Accepts the same filters and pagination as get_requests. " +
        "Start here for 'why is my API request failing?' and then use get_request_details for specifics.",
      inputSchema: { ...filterShape, ...orderShape, ...pagingShape },
      annotations: READ_ONLY,
    },
    handler((entries, args) => getFailedRequests(entries, args)),
  );

  server.registerTool(
    "get_slow_requests",
    {
      title: "Get slow requests",
      description:
        `List completed requests whose duration is at or above threshold_ms (default ${DEFAULT_SLOW_THRESHOLD_MS} ms), slowest first. ` +
        "Accepts method, status, url_contains, since/until filters and pagination. Pending requests are excluded because they have no duration yet.",
      inputSchema: {
        threshold_ms: z
          .number()
          .min(0)
          .max(3_600_000)
          .optional()
          .describe(`Minimum duration in milliseconds (default ${DEFAULT_SLOW_THRESHOLD_MS}).`),
        ...filterShape,
        ...pagingShape,
      },
      annotations: READ_ONLY,
    },
    handler((entries, args) => getSlowRequests(entries, args)),
  );

  server.registerTool(
    "get_request_details",
    {
      title: "Get request details",
      description:
        "Get full details of one captured request by id (ids come from the other tools): timing, status, error, request/response headers. " +
        "Authorization, cookies, API keys, tokens and credential-like URL parameters are replaced with [REDACTED]. " +
        (includeBodies
          ? "Request bodies are included (redacted, truncated) because the server was started with --include-bodies."
          : "Request bodies are hidden by default; only their presence and size are reported."),
      inputSchema: {
        id: z.string().min(1).max(128).describe("The request id, as returned by get_requests."),
      },
      annotations: READ_ONLY,
    },
    handler((entries, args) => getRequestDetails(entries, args, { includeBodies })),
  );

  server.registerTool(
    "analyze_network_activity",
    {
      title: "Analyze network activity",
      description:
        "Structured statistics over captured requests (raw data, no interpretation): totals, pending/failed counts and failure rate, " +
        "status-code and status-class distribution, method and host distribution, duration average/min/max/p50/p95, slowest endpoints, " +
        "most frequent endpoints, endpoints with most failures, and identical requests repeated 3+ times. " +
        "Endpoints are grouped with numeric/UUID path segments normalised to :id. Optional since/until narrow the time window. " +
        "Use this first for 'summarize my app's network activity' or 'which endpoints are slow / called most?'.",
      inputSchema: {
        since: timeValue.optional().describe("Only include requests started at or after this time."),
        until: timeValue.optional().describe("Only include requests started at or before this time."),
        top_n: z
          .number()
          .int()
          .min(1)
          .max(MAX_TOP_N)
          .optional()
          .describe(`Size of the top-N lists (default ${DEFAULT_TOP_N}, max ${MAX_TOP_N}).`),
      },
      annotations: READ_ONLY,
    },
    handler((entries, args) => analyzeNetworkActivity(entries, args)),
  );

  return server;
}
