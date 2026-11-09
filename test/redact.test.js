import test from "node:test";
import assert from "node:assert/strict";
import {
  REDACTED,
  redactHeaders,
  redactText,
  redactUrl,
  summarizeBody,
} from "../src/mcp/redact.js";

test("redactHeaders redacts credentials in object and pair shapes", () => {
  const out = redactHeaders({
    Authorization: "Bearer x",
    cookie: "a=b",
    "Set-Cookie": "sid=1",
    "X-API-Key": "k",
    "x-auth-token": "t",
    "x-session-id": "s",
    "Content-Type": "application/json",
  });
  assert.equal(out["Content-Type"], "application/json");
  for (const k of ["Authorization", "cookie", "Set-Cookie", "X-API-Key", "x-auth-token", "x-session-id"]) {
    assert.equal(out[k], REDACTED, k);
  }
  assert.deepEqual(redactHeaders([["Authorization", "x"], ["accept", "*/*"]]), {
    Authorization: REDACTED,
    accept: "*/*",
  });
});

test("redactHeaders tolerates junk input", () => {
  assert.deepEqual(redactHeaders(undefined), {});
  assert.deepEqual(redactHeaders(null), {});
  assert.deepEqual(redactHeaders("nope"), {});
  assert.deepEqual(redactHeaders({}), {});
});

test("redactUrl hides userinfo and sensitive query params only", () => {
  const out = redactUrl("https://u:p@host.test/a?page=2&api_key=SECRET&access_token=T&q=hello");
  assert.ok(!out.includes("SECRET") && !out.includes("u:p@"));
  assert.ok(out.includes("page=2") && out.includes("q=hello"));
  assert.ok(out.includes(`api_key=${REDACTED}`));
  assert.equal(redactUrl("unknown"), "unknown");
});

test("redactText scrubs bearer tokens and URLs in error messages", () => {
  const out = redactText("failed Bearer abc.def.ghi at https://h.test/x?token=ZZZ");
  assert.ok(!out.includes("abc.def.ghi") && !out.includes("ZZZ"));
});

test("summarizeBody hides content by default", () => {
  const s = summarizeBody('{"password":"hunter2"}');
  assert.equal(s.present, true);
  assert.equal(s.content, undefined);
  assert.ok(!JSON.stringify(s).includes("hunter2"));
  assert.deepEqual(summarizeBody(undefined), { present: false });
});

test("summarizeBody with includeBodies redacts JSON keys, form fields and truncates", () => {
  const json = summarizeBody('{"user":"a","nested":{"password":"hunter2"}}', { includeBodies: true });
  assert.ok(json.content.includes('"user":"a"'));
  assert.ok(!json.content.includes("hunter2"));
  const form = summarizeBody("name=bob&password=hunter2&token=zzz", { includeBodies: true });
  assert.ok(form.content.includes("name=bob") && !form.content.includes("hunter2") && !form.content.includes("zzz"));
  const big = summarizeBody("x".repeat(10000), { includeBodies: true });
  assert.equal(big.truncated, true);
  assert.ok(big.content.length < 2100);
  const stream = summarizeBody({ pipe() {} }, { includeBodies: true });
  assert.equal(stream.content, undefined);
});
