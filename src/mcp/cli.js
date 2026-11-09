// Entry point for `netspy mcp`. Loaded lazily from bin/netspy.js so the normal
// `netspy <command>` path never imports the MCP SDK.
//
// IMPORTANT: stdout is the MCP protocol channel. Never console.log() here;
// all diagnostics go to stderr.

import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { createHttpSource } from "./source.js";

const USAGE = `Usage: netspy mcp [--port <n>] [--include-bodies]

Starts a read-only MCP server (stdio) that exposes requests captured by a
running NetSpy instance to AI agents.

Options:
  -p, --port <n>      Port of the running NetSpy panel (default: auto-detect 4000-4019)
      --include-bodies  Also expose request bodies (redacted and truncated). Off by default.
  -h, --help          Show this help

Start your app first with:  netspy npm run dev`;

export function parseMcpArgs(argv) {
  const opts = { port: undefined, includeBodies: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--include-bodies") opts.includeBodies = true;
    else if (arg === "-p" || arg === "--port") {
      const value = argv[++i];
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${value ?? "(missing)"}`);
      }
      opts.port = port;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

export async function runMcp(argv) {
  let opts;
  try {
    opts = parseMcpArgs(argv);
  } catch (err) {
    console.error(`netspy mcp: ${err.message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (opts.help) {
    console.error(USAGE);
    return;
  }

  const pkg = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const server = createMcpServer(createHttpSource({ port: opts.port }), {
    includeBodies: opts.includeBodies,
    version: pkg.version,
  });
  await server.connect(new StdioServerTransport());
  console.error(
    `netspy mcp: ready (${opts.port ? `port ${opts.port}` : "auto-detecting NetSpy on ports 4000-4019"}${opts.includeBodies ? ", bodies exposed" : ""})`,
  );
}
