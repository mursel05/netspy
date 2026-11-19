#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.js";
import { DEFAULT_PORT, buildSpawn, parseArgs } from "../src/cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERCEPT_PATH = path.join(__dirname, "..", "src", "intercept.cjs");
const MAX_PORT_ATTEMPTS = 20;
const IS_WINDOWS = process.platform === "win32";

const USAGE = `Usage: netspy [options] <command> [args...]
       netspy mcp [--port <n>] [--include-bodies]

Wraps a dev command and shows its server-side requests in a live panel.

Options:
  -p, --port <n>   Panel port (default ${DEFAULT_PORT}; the next free port is used if taken)
      --no-open    Don't open the panel in a browser
  -h, --help       Show this help
  -v, --version    Show the version

Examples:
  netspy npm run dev
  netspy -p 9000 node server.js
  netspy next dev -p 3001        # flags after the command go to the command`;

function readVersion() {
  const pkg = JSON.parse(
    readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  return pkg.version;
}

function openBrowser(url) {
  const cmd = IS_WINDOWS
    ? "cmd"
    : process.platform === "darwin"
      ? "open"
      : "xdg-open";
  const args = IS_WINDOWS ? ["/c", "start", '""', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // A missing opener (headless Linux, Docker, CI) emits 'error'
    // asynchronously; without a listener it would crash NetSpy.
    child.on("error", () => {
      console.log(`  (Could not open a browser; open ${url} manually.)`);
    });
    child.unref();
  } catch {}
}

async function startServerWithFallback(startPort) {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = startPort + attempt;
    if (port > 65535) break;
    try {
      const server = await startServer(port);
      if (attempt > 0) {
        console.log(`  Port ${startPort} was in use, using ${port} instead.`);
      }
      return { server, port };
    } catch (err) {
      if (err && (err.code === "EADDRINUSE" || err.code === "EACCES")) continue;
      throw err;
    }
  }
  throw new Error(
    `no free port between ${startPort} and ${Math.min(65535, startPort + MAX_PORT_ATTEMPTS - 1)}`,
  );
}

function exitCodeForSignal(signal) {
  const num = os.constants.signals[signal];
  return num ? 128 + num : 1;
}

async function main() {
  // `netspy mcp ...` runs the MCP server instead of wrapping a command.
  if (process.argv[2] === "mcp") {
    const { runMcp } = await import("../src/mcp/cli.js");
    return runMcp(process.argv.slice(3));
  }

  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`netspy: ${err.message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.version) {
    console.log(readVersion());
    return;
  }
  if (opts.command.length === 0) {
    console.error(USAGE);
    process.exit(1);
  }

  let server, port;
  try {
    ({ server, port } = await startServerWithFallback(opts.port));
  } catch (err) {
    console.error(`netspy: failed to start panel server: ${err.message}`);
    process.exit(1);
  }

  const panelUrl = `http://127.0.0.1:${port}`;
  console.log(`\n  Netspy panel running at ${panelUrl}\n`);
  if (opts.open) openBrowser(panelUrl);

  const { file, args, shell, env } = buildSpawn(opts.command);
  const existingNodeOptions = process.env.NODE_OPTIONS || "";
  const child = spawn(file, args, {
    stdio: "inherit",
    shell,
    env: {
      ...process.env,
      ...env,
      NODE_OPTIONS:
        `${existingNodeOptions} --require ${JSON.stringify(INTERCEPT_PATH)}`.trim(),
      NETSPY_PORT: String(port),
    },
  });

  child.on("error", (err) => {
    console.error(
      err.code === "ENOENT"
        ? `netspy: command not found: ${file}`
        : `netspy: failed to start command: ${err.message}`,
    );
    server.close();
    process.exit(err.code === "ENOENT" ? 127 : 1);
  });

  child.on("exit", (code, signal) => {
    server.close();
    process.exit(signal ? exitCodeForSignal(signal) : (code ?? 0));
  });

  // Ctrl+C in a terminal already reaches the whole foreground process group,
  // so the child gets SIGINT on its own; forwarding it again would make many
  // dev servers treat it as a second "force quit" press. Only forward SIGINT
  // when it was sent to NetSpy alone (no TTY, e.g. `kill -INT`).
  process.on("SIGINT", () => {
    if (!process.stdin.isTTY) child.kill("SIGINT");
  });
  for (const signal of ["SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
}

main();
