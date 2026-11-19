// Pure helpers for the `netspy <command>` CLI (no side effects, unit-tested).

export const DEFAULT_PORT = 4000;

export class UsageError extends Error {}

function parsePort(value) {
  const port = Number(value);
  if (value === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`Invalid port: ${value ?? "(missing)"}`);
  }
  return port;
}

/**
 * NetSpy options are only recognised *before* the wrapped command, so flags
 * meant for the command (e.g. `netspy next dev -p 3001`) are passed through.
 */
export function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, open: true, help: false, version: false };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      i += 1;
      break;
    }
    if (arg === "-p" || arg === "--port") {
      opts.port = parsePort(argv[i + 1]);
      i += 2;
    } else if (arg.startsWith("--port=")) {
      opts.port = parsePort(arg.slice("--port=".length));
      i += 1;
    } else if (arg === "--no-open") {
      opts.open = false;
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      opts.help = true;
      i += 1;
    } else if (arg === "-v" || arg === "--version") {
      opts.version = true;
      i += 1;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else {
      break;
    }
  }
  return { ...opts, command: argv.slice(i) };
}

/** Quotes one argument for cmd.exe (Windows needs a shell to run .cmd shims). */
function quoteForCmd(arg) {
  if (arg === "") return '""';
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Builds the spawn() call for the wrapped command.
 * - One argument (`netspy "npm run dev && x"`) is a shell string: run it via the shell.
 * - Several arguments (`netspy npm run dev`) are spawned directly, so arguments
 *   with spaces or quotes are passed through untouched and signals reach the
 *   real process instead of an intermediate shell.
 * - Leading `NAME=value` arguments become environment variables.
 */
export function buildSpawn(command, { windows = process.platform === "win32" } = {}) {
  const env = {};
  let rest = command;
  while (rest.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) {
    const eq = rest[0].indexOf("=");
    env[rest[0].slice(0, eq)] = rest[0].slice(eq + 1);
    rest = rest.slice(1);
  }

  if (rest.length === 1) {
    return { file: rest[0], args: [], shell: true, env };
  }
  if (windows) {
    return { file: rest.map(quoteForCmd).join(" "), args: [], shell: true, env };
  }
  return { file: rest[0], args: rest.slice(1), shell: false, env };
}
