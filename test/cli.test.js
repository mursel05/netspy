import test from "node:test";
import assert from "node:assert/strict";
import { UsageError, buildSpawn, parseArgs } from "../src/cli.js";

test("parseArgs: options before the command are NetSpy's", () => {
  const r = parseArgs(["-p", "9000", "--no-open", "npm", "run", "dev"]);
  assert.equal(r.port, 9000);
  assert.equal(r.open, false);
  assert.deepEqual(r.command, ["npm", "run", "dev"]);
});

test("parseArgs: flags after the command are passed through untouched", () => {
  const r = parseArgs(["next", "dev", "-p", "3001", "--help"]);
  assert.equal(r.port, 4000);
  assert.equal(r.help, false);
  assert.deepEqual(r.command, ["next", "dev", "-p", "3001", "--help"]);
});

test("parseArgs: --port=, -- separator, help and version", () => {
  assert.equal(parseArgs(["--port=5000", "x"]).port, 5000);
  assert.deepEqual(parseArgs(["--", "-weird", "a"]).command, ["-weird", "a"]);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--version"]).version, true);
});

test("parseArgs: invalid ports and unknown options are rejected", () => {
  for (const argv of [["-p"], ["-p", "abc", "x"], ["-p", "0", "x"], ["-p", "70000", "x"], ["--bogus", "x"]]) {
    assert.throws(() => parseArgs(argv), UsageError, JSON.stringify(argv));
  }
});

test("buildSpawn: several args are spawned directly, preserving spaces", () => {
  const r = buildSpawn(["node", "app.js", "hello world", 'a"b'], { windows: false });
  assert.deepEqual(r, { file: "node", args: ["app.js", "hello world", 'a"b'], shell: false, env: {} });
});

test("buildSpawn: a single argument is a shell string", () => {
  const r = buildSpawn(["npm run build && npm start"], { windows: false });
  assert.equal(r.shell, true);
  assert.equal(r.file, "npm run build && npm start");
});

test("buildSpawn: leading NAME=value args become env vars", () => {
  const r = buildSpawn(["PORT=3001", "DEBUG=a=b", "node", "app.js"], { windows: false });
  assert.deepEqual(r.env, { PORT: "3001", DEBUG: "a=b" });
  assert.equal(r.file, "node");
  assert.deepEqual(r.args, ["app.js"]);
});

test("buildSpawn: Windows goes through cmd with quoted args", () => {
  const r = buildSpawn(["npm", "run", "dev", "hello world", 'say "hi"'], { windows: true });
  assert.equal(r.shell, true);
  assert.equal(r.file, 'npm run dev "hello world" "say ""hi"""');
});
