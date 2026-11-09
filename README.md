# Netspy

Wrap any dev command and watch its server-side requests live, in a
DevTools-style network panel in your browser — even though those requests
never touch the browser's own Network tab.

```bash
netspy npm run dev
#    opens http://localhost:4000 with a live list of every request
#    your server process makes (SSR data fetching, RSC loaders, etc.)
```

Works with Next.js, Remix, plain Express, or anything else that runs on
Node 18+, since it patches the _global_ `fetch`, not framework internals.

## Install & use

```bash
npm install -g netspy

netspy npm run dev                # default port 4000
netspy -p 9000 npm run dev        # specify a port
netspy node server.js             # run a custom server script
```

Open the printed URL (it also tries to auto-open your default browser).
Every server-side request call made by the wrapped process — at boot,
during SSR, in route handlers, anywhere — shows up as a row with method,
URL, status, and duration. Click a row for details. Use the filter box to
narrow by URL. "Clear" wipes the current session's log.

## MCP server (let AI agents read your captured requests)

Netspy can expose what it captured to any [MCP](https://modelcontextprotocol.io)-compatible
client (Claude Desktop, Claude Code, Cursor, VS Code, …) so you can ask things like
_"why is my API request failing?"_ and the agent answers from your **real** captured
traffic instead of guessing.

```
 your dev server ──(patched fetch/http/https)──▶ netspy <cmd>  ──▶ panel + GET /__entries
                                                                          ▲  (127.0.0.1 only)
 AI client ◀──stdio / MCP──▶ netspy mcp  ─────────────────────────────────┘
```

### Setup

1. Start your app through Netspy as usual:

   ```bash
   netspy npm run dev
   ```

2. Point your MCP client at `netspy mcp`. It auto-detects the running Netspy
   panel on ports 4000–4019; if you started Netspy with `-p 9000`, add
   `--port 9000`.

**Claude Desktop / Cursor / any client using `mcpServers` JSON**

```json
{
  "mcpServers": {
    "netspy": {
      "command": "npx",
      "args": ["-y", "netspy", "mcp"]
    }
  }
}
```

With a fixed port: `"args": ["-y", "netspy", "mcp", "--port", "9000"]`.

**Claude Code**

```bash
claude mcp add netspy -- npx -y netspy mcp
```

**Running from a local checkout** (e.g. before the MCP release is on npm)

```bash
node /path/to/netspy/bin/netspy.js mcp
```

> `netspy mcp` only reads data; it does not start your app. Start
> `netspy <your command>` first. If it isn't running, tools return an error
> that says so.

### Tools

All tools are read-only and return JSON.

| Tool | What it does |
| --- | --- |
| `get_requests` | List captured requests. Filters: `method`, `status` (`404`, `"5xx"`, `"error"`, `"pending"`), `url_contains`, `since`, `until`. Pagination: `limit` (default 25, max 200), `offset`; `order` = `desc` (newest first, default) or `asc`. |
| `get_failed_requests` | HTTP errors (status ≥ 400) and network errors (DNS, connection refused, …) with error messages and a `failureType`. Same filters and pagination. |
| `get_slow_requests` | Completed requests at or above `threshold_ms` (default 1000), slowest first. Same filters and pagination. |
| `get_request_details` | One request by `id`: timing, status, error, redacted request/response headers, body metadata. |
| `analyze_network_activity` | Raw statistics: totals, pending/failed counts and failure rate, status-code and status-class distribution, method/host distribution, duration avg/min/max/p50/p95, slowest endpoints, most frequent endpoints, endpoints with most failures, identical requests repeated 3+ times. Optional `since`, `until`, `top_n`. |

Times (`since`/`until`) accept ISO-8601 strings or epoch milliseconds. Endpoint
statistics group numeric and UUID path segments as `:id` (`/users/42` →
`/users/:id`) and ignore query strings.

### Example prompts

- "Why is my API request failing?"
- "Show me all requests returning 500 errors."
- "Which endpoints are responding slowly? Anything over 500 ms?"
- "What are the most frequently called endpoints? Do you see duplicate calls I could dedupe?"
- "Summarize the network activity of my app."
- "Are there any suspicious patterns in the captured requests?"
- "What happened in the last 5 minutes?" (the agent can pass `since`)

### Security and privacy model

- **Read-only.** There are no tools that run commands, make HTTP requests, or
  change Netspy state. The MCP process only talks to Netspy's own
  `GET /__entries` endpoint on `127.0.0.1`.
- **Redaction before exposure.** Every value passes through a redactor before
  leaving the MCP process:
  - Headers named `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`,
    `X-Api-Key`, or containing `token`, `secret`, `password`, `api-key`, `auth`,
    `session`, `credential`, `signature` (and similar) are replaced with `[REDACTED]`.
  - URL credentials (`user:pass@`) and sensitive query parameters
    (`?api_key=…`, `?access_token=…`) are redacted in every output, including
    error messages.
  - `url_contains` matches the *redacted* URL, so filters can't be used to
    probe for hidden secrets.
- **Bodies are hidden by default.** Only whether a request body exists and its
  size are reported. Start `netspy mcp --include-bodies` to also expose string
  request bodies (JSON keys / form fields that look like credentials are still
  redacted, and bodies are truncated to 2 KB).
- **Input validation and limits.** All arguments are schema-validated;
  `limit` ≤ 200, `top_n` ≤ 50, response size from Netspy is capped.
- **Local only.** Transport is stdio; nothing listens for MCP connections on the network.
- Redaction is pattern-based and best-effort. A secret placed in an
  unconventionally named header or inside a free-form URL path can still get
  through, so treat captured traffic as sensitive and only connect clients you trust.

### Architecture

The MCP code lives in `src/mcp/` and is loaded lazily only by `netspy mcp`;
the interceptor, panel server and `netspy <command>` flow are unchanged.

- `source.js` fetches entries from the running panel (`GET /__entries`) and discovers its port.
- `queries.js` is pure logic: filtering, pagination, failures, slow requests, analysis.
- `redact.js` is the redaction layer.
- `server.js` registers the tools with the official `@modelcontextprotocol/sdk`.
- `cli.js` wires it to stdio.

### Limitations

- History is in memory (max 1000 entries) and resets when Netspy restarts.
- Only requests made by the wrapped process are captured, and only the request
  side of bodies; response bodies are not captured.
- `fetch()` calls that pass a `Headers` instance, and `fetch()` response
  headers, currently arrive empty because the interceptor serializes them as `{}`.
  Headers from the `http`/`https` modules and plain-object headers are shown (redacted).
- With several Netspy instances running, auto-detect picks the lowest port;
  use `--port` to choose one.

## Development

```bash
npm install
npm test        # unit, integration and end-to-end tests (node:test, no extra deps)
```
