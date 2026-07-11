import assert from "node:assert/strict";
import test from "node:test";
import { sameOrigin, UrlValidationError, validateApiUrl } from "../dist/url-guard.js";

test("accepts http for loopback hosts", () => {
  for (const host of [
    "http://localhost:8000/api",
    "http://127.0.0.1:8000/api",
    "http://127.9.9.9:8000/api",
  ]) {
    assert.doesNotThrow(() => validateApiUrl(host));
  }
});

test("rejects http for non-loopback hosts", () => {
  assert.throws(() => validateApiUrl("http://dashboard.example.com/api"), UrlValidationError);
});

test("accepts https for non-loopback hosts", () => {
  assert.doesNotThrow(() => validateApiUrl("https://dashboard.example.com/api"));
});

test("rejects unsupported protocols", () => {
  assert.throws(() => validateApiUrl("ftp://dashboard.example.com/api"), UrlValidationError);
  assert.throws(() => validateApiUrl("file:///etc/passwd"), UrlValidationError);
});

test("rejects embedded credentials", () => {
  assert.throws(() => validateApiUrl("https://user:pass@dashboard.example.com/api"), UrlValidationError);
});

test("rejects malformed URLs", () => {
  assert.throws(() => validateApiUrl("not a url"), UrlValidationError);
});

test("enforces KAELIX_ALLOWED_HOSTS allowlist for non-loopback hosts", () => {
  assert.throws(
    () => validateApiUrl("https://evil.example.com/api", { allowedHosts: ["dashboard.example.com"] }),
    UrlValidationError,
  );
  assert.doesNotThrow(() =>
    validateApiUrl("https://dashboard.example.com/api", { allowedHosts: ["dashboard.example.com"] }),
  );
});

test("allowlist does not restrict loopback hosts", () => {
  assert.doesNotThrow(() =>
    validateApiUrl("http://localhost:8000/api", { allowedHosts: ["dashboard.example.com"] }),
  );
});

test("allowlist matching is case-insensitive and ignores a trailing dot", () => {
  assert.doesNotThrow(() =>
    validateApiUrl("https://Dashboard.Example.com./api", { allowedHosts: ["dashboard.example.com"] }),
  );
});

test("sameOrigin compares protocol, hostname, and effective port", () => {
  const a = new URL("https://dashboard.example.com/api");
  const b = new URL("https://dashboard.example.com:443/api/tasks");
  const c = new URL("https://other.example.com/api");
  const d = new URL("http://dashboard.example.com/api");
  assert.equal(sameOrigin(a, b), true);
  assert.equal(sameOrigin(a, c), false);
  assert.equal(sameOrigin(a, d), false);
});
