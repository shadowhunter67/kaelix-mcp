import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets, redactValue } from "../dist/redact.js";

test("redacts bearer tokens from free text", () => {
  const out = redactSecrets("Kaelix API returned 401: Bearer abcdefgh12345678 was rejected");
  assert.equal(out.includes("abcdefgh12345678"), false);
  assert.match(out, /\[redacted\]/);
});

test("redacts Cookie headers from free text", () => {
  const out = redactSecrets("Request failed. Cookie: kaelix_session=super-secret-value; Path=/");
  assert.equal(out.includes("super-secret-value"), false);
});

test("redacts key=value style secrets", () => {
  const out = redactSecrets('config dump: api_key="sk-verysecretvalue123"');
  assert.equal(out.includes("sk-verysecretvalue123"), false);
});

test("leaves ordinary text untouched", () => {
  const text = "Task 42 was approved by reviewer.";
  assert.equal(redactSecrets(text), text);
});

test("redactValue walks nested objects and arrays, redacting secret-shaped keys", () => {
  const input = {
    ok: true,
    data: {
      apiToken: "should-not-appear",
      nested: [{ Authorization: "Bearer abcdefgh12345678" }, "plain string"],
    },
  };
  const out = redactValue(input);
  assert.equal(out.data.apiToken, "[redacted]");
  assert.equal(out.data.nested[0].Authorization, "[redacted]");
  assert.equal(out.data.nested[1], "plain string");
  assert.equal(out.ok, true);
});

test("redactValue does not crash on circular references", () => {
  const obj = { a: 1 };
  obj.self = obj;
  assert.doesNotThrow(() => redactValue(obj));
});
