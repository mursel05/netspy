#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERCEPT_PATH = path.join(__dirname, "..", "src", "intercept.cjs");

const DEFAULT_PORT = 4000;

function parseArgs(argv) {
  let port = DEFAULT_PORT;
  const rest = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      port = Number(argv[i + 1]);
      i += 2;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = Number(arg.split("=")[1]);
      i += 1;
      continue;
    }
    rest.push(arg);
    i += 1;
  }

  return { port, command: rest };
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

async function main() {
  const { port, command } = parseArgs(process.argv.slice(2));

  if (command.length === 0) {
    console.error("Usage: netspy [--port 4000] <command> [args...]");
    console.error("Example: netspy npm run dev");
    process.exit(1);
  }

  let server;
  try {
    server = await startServer(port);
  } catch (err) {
    console.error(
      `Netspy: failed to start panel server on port ${port}: ${err.message}`,
    );
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
