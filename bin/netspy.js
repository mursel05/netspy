#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERCEPT_PATH = path.join(__dirname, "..", "src", "intercept.cjs");
const DEFAULT_PORT = 4000;
const MAX_PORT_ATTEMPTS = 20;

function parseArgs(argv) {
  let requestedPort = DEFAULT_PORT;
  const rest = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "-p") {
      requestedPort = Number(argv[i + 1]);
      i += 2;
      continue;
    }
    rest.push(arg);
    i += 1;
  }

  return { requestedPort, command: rest };
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: platform === "win32",
    }).unref();
  } catch {}
}

async function startServerWithFallback(startPort) {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = startPort + attempt;
    try {
      const server = await startServer(port);
      if (attempt > 0) {
        console.log(`  Port ${startPort} was in use — using ${port} instead.`);
      }
      return { server, port };
    } catch (err) {
      if (err && err.code === "EADDRINUSE") continue;
      throw err;
    }
  }
  throw new Error(
    `all ports from ${startPort} to ${startPort + MAX_PORT_ATTEMPTS - 1} are in use`,
  );
}

async function main() {
  const { requestedPort, command } = parseArgs(process.argv.slice(2));

  if (command.length === 0) {
    console.error("Usage: netspy [-p 4000] <command> [args...]");
    console.error("Example: netspy npm run dev");
    process.exit(1);
  }

  let server, port;
  try {
    ({ server, port } = await startServerWithFallback(requestedPort));
  } catch (err) {
    console.error(`Netspy: failed to start panel server: ${err.message}`);
    process.exit(1);
  }

  const panelUrl = `http://localhost:${port}`;
  console.log(`\n  Netspy panel running at ${panelUrl}\n`);
  openBrowser(panelUrl);

  const existingNodeOptions = process.env.NODE_OPTIONS || "";
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      NODE_OPTIONS:
        `${existingNodeOptions} --require ${JSON.stringify(INTERCEPT_PATH)}`.trim(),
      NETSPY_PORT: String(port),
    },
  });

  child.on("exit", (code) => {
    server.close();
    process.exit(code ?? 0);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
}

main();
