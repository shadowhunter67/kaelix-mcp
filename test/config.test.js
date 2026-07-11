import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, DEFAULT_TIMEOUT_MS, loadConfig, parseTimeoutMs } from "../dist/config.js";
import { UrlValidationError } from "../dist/url-guard.js";

test("parseTimeoutMs accepts the default when unset", () => {
  assert.equal(parseTimeoutMs(undefined), DEFAULT_TIMEOUT_MS);
  assert.equal(parseTimeoutMs(""), DEFAULT_TIMEOUT_MS);
});

test("parseTimeoutMs accepts integers within [1000, 120000]", () => {
  assert.equal(parseTimeoutMs("1000"), 1000);
  assert.equal(parseTimeoutMs("120000"), 120000);
  assert.equal(parseTimeoutMs("45000"), 45000);
});

for (const bad of ["abc", "NaN", "-1", "0", "999", "120001", "12.5", "1e3"]) {
  test(`parseTimeoutMs rejects "${bad}"`, () => {
    assert.throws(() => parseTimeoutMs(bad), ConfigError);
  });
}

test("parseTimeoutMs treats whitespace-only as unset (falls back to the default)", () => {
  assert.equal(parseTimeoutMs(" "), DEFAULT_TIMEOUT_MS);
});

test("parseTimeoutMs trims surrounding whitespace around a valid integer", () => {
  assert.equal(parseTimeoutMs("1000 "), 1000);
  assert.equal(parseTimeoutMs(" 1000"), 1000);
});

function withEnv(overrides, fn) {
  const original = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("KAELIX_")) delete process.env[key];
    }
    Object.assign(process.env, overrides);
    return fn();
  } finally {
    process.env = original;
  }
}

test("loadConfig requires KAELIX_SESSION_COOKIE when cookie auth is opted in", () => {
  withEnv({ KAELIX_ALLOW_COOKIE_AUTH: "true" }, () => {
    assert.throws(() => loadConfig(), ConfigError);
  });
});

test("loadConfig ignores the cookie unless both opt-in flag and cookie are set", () => {
  withEnv({ KAELIX_SESSION_COOKIE: "kaelix_session=abc" }, () => {
    const config = loadConfig();
    assert.equal(config.allowCookieAuth, false);
    assert.equal(config.sessionCookie, undefined);
  });
});

test("loadConfig accepts cookie auth when both flag and cookie are present", () => {
  withEnv({ KAELIX_ALLOW_COOKIE_AUTH: "true", KAELIX_SESSION_COOKIE: "kaelix_session=abc" }, () => {
    const config = loadConfig();
    assert.equal(config.allowCookieAuth, true);
    assert.equal(config.sessionCookie, "kaelix_session=abc");
  });
});

test("loadConfig rejects an insecure non-loopback KAELIX_API_URL", () => {
  withEnv({ KAELIX_API_URL: "http://dashboard.example.com/api" }, () => {
    assert.throws(() => loadConfig(), UrlValidationError);
  });
});

test("loadConfig parses KAELIX_ALLOWED_HOSTS into a list", () => {
  withEnv(
    {
      KAELIX_API_URL: "https://dashboard.example.com/api",
      KAELIX_ALLOWED_HOSTS: "dashboard.example.com, other.example.com",
    },
    () => {
      const config = loadConfig();
      assert.deepEqual(config.allowedHosts, ["dashboard.example.com", "other.example.com"]);
    },
  );
});

test("loadConfig defaults enableLocalAiTools to auto and honors on/off overrides", () => {
  withEnv({}, () => assert.equal(loadConfig().enableLocalAiTools, "auto"));
  withEnv({ KAELIX_ENABLE_LOCAL_AI_TOOLS: "on" }, () => assert.equal(loadConfig().enableLocalAiTools, "on"));
  withEnv({ KAELIX_ENABLE_LOCAL_AI_TOOLS: "off" }, () =>
    assert.equal(loadConfig().enableLocalAiTools, "off"),
  );
});
