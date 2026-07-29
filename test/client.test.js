import assert from "node:assert/strict";
import test from "node:test";
import { createClientFromEnv, KaelixApiError, KaelixClient } from "../dist/client.js";
import { UrlValidationError } from "../dist/url-guard.js";

function response(body, init = {}) {
  return new Response(init.status === 204 ? null : body, init);
}

test("builds API URL and bearer auth header", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api/",
    apiToken: "token-123",
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenAuth = new Headers(init?.headers).get("Authorization") || "";
      return response('{"ok":true}', { status: 200 });
    },
  });

  const result = await client.request("/agents");
  assert.equal(seenUrl, "http://localhost:8000/api/agents");
  assert.equal(seenAuth, "Bearer token-123");
  assert.deepEqual(result, { ok: true });
});

test("trims a long trailing-slash suffix in linear time", () => {
  const client = new KaelixClient({
    baseUrl: `http://localhost:8000/api${"/".repeat(100_000)}`,
  });

  assert.equal(client.baseUrl, "http://localhost:8000/api");
});

test("supports local-dev cookie auth", async () => {
  let seenCookie = "";
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    sessionCookie: "dash_session=abc",
    allowCookieAuth: true,
    fetchImpl: async (_url, init) => {
      seenCookie = new Headers(init?.headers).get("Cookie") || "";
      return response("{}", { status: 200 });
    },
  });

  await client.request("/tasks");
  assert.equal(seenCookie, "dash_session=abc");
});

test("ignores cookie auth unless explicitly enabled", async () => {
  let seenCookie = "unset";
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    sessionCookie: "dash_session=abc",
    fetchImpl: async (_url, init) => {
      seenCookie = new Headers(init?.headers).get("Cookie") || "";
      return response("{}", { status: 200 });
    },
  });

  await client.request("/tasks");
  assert.equal(client.authMode, "none");
  assert.equal(seenCookie, "");
});

test("prefers bearer token and never sends the cookie when both are configured", async () => {
  let seenCookie = "unset";
  let seenAuth = "";
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    apiToken: "token-123",
    sessionCookie: "dash_session=abc",
    allowCookieAuth: true,
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init?.headers);
      seenCookie = headers.get("Cookie") || "";
      seenAuth = headers.get("Authorization") || "";
      return response("{}", { status: 200 });
    },
  });

  assert.equal(client.authMode, "bearer");
  await client.request("/tasks");
  assert.equal(seenAuth, "Bearer token-123");
  assert.equal(seenCookie, "");
});

test("returns undefined for 204 responses", async () => {
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    fetchImpl: async () => response("", { status: 204 }),
  });

  assert.equal(await client.request("/tasks/1/reject", { method: "POST" }), undefined);
});

test("classifies auth, forbidden, conflict, and rate-limit errors", async () => {
  const cases = [
    [401, "auth"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [422, "validation"],
    [429, "rate_limit"],
    [500, "backend"],
  ];
  for (const [status, kind] of cases) {
    const client = new KaelixClient({
      baseUrl: "http://localhost:8000/api",
      fetchImpl: async () => response('{"detail":"boom"}', { status, statusText: "x" }),
    });
    await assert.rejects(client.request("/agents"), (error) => {
      assert.equal(error instanceof KaelixApiError, true);
      assert.equal(error.kind, kind, `status ${status}`);
      return true;
    });
  }
});

test("reports non-JSON success responses as parse errors", async () => {
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    fetchImpl: async () => response("<html>not json</html>", { status: 200 }),
  });

  await assert.rejects(client.request("/agents"), (error) => {
    assert.equal(error instanceof KaelixApiError, true);
    assert.equal(error.kind, "parse");
    return true;
  });
});

test("turns network failures into friendly errors", async () => {
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  await assert.rejects(client.request("/agents"), (error) => {
    assert.equal(error instanceof KaelixApiError, true);
    assert.equal(error.kind, "network");
    assert.match(error.message, /Could not reach/);
    return true;
  });
});

test("turns AbortError failures into timeout errors", async () => {
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    fetchImpl: async () => {
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    },
  });

  await assert.rejects(client.request("/agents"), (error) => {
    assert.equal(error instanceof KaelixApiError, true);
    assert.equal(error.kind, "timeout");
    assert.match(error.message, /timed out/);
    return true;
  });
});

test("error messages redact secrets echoed back by the backend", async () => {
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    fetchImpl: async () =>
      response(JSON.stringify({ detail: "rejected token Bearer abcdefgh12345678" }), {
        status: 401,
        statusText: "Unauthorized",
      }),
  });

  await assert.rejects(client.request("/agents"), (error) => {
    assert.equal(error.message.includes("abcdefgh12345678"), false);
    return true;
  });
});

test("constructor rejects an insecure non-loopback base URL", () => {
  assert.throws(() => new KaelixClient({ baseUrl: "http://dashboard.example.com/api" }), UrlValidationError);
});

test("rejects oversized responses instead of buffering them fully", async () => {
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    maxResponseBytes: 10,
    fetchImpl: async () => response('{"data":"way more than ten bytes of json"}', { status: 200 }),
  });

  await assert.rejects(client.request("/agents"), (error) => {
    assert.equal(error instanceof KaelixApiError, true);
    assert.equal(error.kind, "response_too_large");
    return true;
  });
});

test("strips Authorization/Cookie when following a cross-origin redirect", async () => {
  const calls = [];
  const client = new KaelixClient({
    baseUrl: "https://dashboard.example.com/api",
    apiToken: "token-123",
    fetchImpl: async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get("Authorization") });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://other.example.com/api/agents" },
        });
      }
      return response("{}", { status: 200 });
    },
  });

  await client.request("/agents");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].auth, "Bearer token-123");
  assert.equal(calls[1].auth, null);
});

test("keeps Authorization when a redirect stays same-origin", async () => {
  const calls = [];
  const client = new KaelixClient({
    baseUrl: "https://dashboard.example.com/api",
    apiToken: "token-123",
    fetchImpl: async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get("Authorization") });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://dashboard.example.com/api/agents/" },
        });
      }
      return response("{}", { status: 200 });
    },
  });

  await client.request("/agents");
  assert.equal(calls[1].auth, "Bearer token-123");
});

test("rejects a redirect Location that points at a disallowed protocol/host", async () => {
  const client = new KaelixClient({
    baseUrl: "https://dashboard.example.com/api",
    fetchImpl: async () =>
      new Response(null, { status: 302, headers: { Location: "http://internal.example.com/secrets" } }),
  });

  await assert.rejects(client.request("/agents"));
});

test("retries a GET on a 503 and eventually succeeds", async () => {
  let attempts = 0;
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) return response("service unavailable", { status: 503 });
      return response('{"ok":true}', { status: 200 });
    },
  });

  const result = await client.request("/agents");
  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
});

test("does not retry a POST (write) request on failure", async () => {
  let attempts = 0;
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    fetchImpl: async () => {
      attempts++;
      return response("service unavailable", { status: 503 });
    },
  });

  await assert.rejects(client.request("/tasks", { method: "POST", body: "{}" }));
  assert.equal(attempts, 1);
});

test("retries a GET on 429 honoring Retry-After, and succeeds", async () => {
  let attempts = 0;
  const start = Date.now();
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) {
        return response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
      }
      return response('{"ok":true}', { status: 200 });
    },
  });

  const result = await client.request("/agents");
  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
  // Retry-After: 0 means the retry should not have waited any meaningful amount.
  assert.ok(Date.now() - start < 500, "retry with Retry-After: 0 should not add real delay");
});

test("gives up after exhausting retries on a persistent 429 and surfaces rate_limit", async () => {
  let attempts = 0;
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    fetchImpl: async () => {
      attempts++;
      return response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
    },
  });

  await assert.rejects(client.request("/agents"), (error) => {
    assert.equal(error instanceof KaelixApiError, true);
    assert.equal(error.kind, "rate_limit");
    return true;
  });
  assert.equal(attempts, 2); // MAX_RETRY_ATTEMPTS = 2 total attempts, not unbounded
});

test("never retries a write request on 429, even though rate_limit is retryable for reads", async () => {
  let attempts = 0;
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    fetchImpl: async () => {
      attempts++;
      return response("rate limited", { status: 429, headers: { "Retry-After": "1" } });
    },
  });

  await assert.rejects(client.request("/tasks/1/approve", { method: "POST" }));
  assert.equal(attempts, 1);
});

test("warns when cookie auth is enabled without a bearer token", () => {
  const originalEnv = { ...process.env };
  const originalWarn = console.warn;
  const warnings = [];

  try {
    process.env.KAELIX_API_URL = "http://localhost:8000/api";
    delete process.env.KAELIX_API_TOKEN;
    process.env.KAELIX_ALLOW_COOKIE_AUTH = "true";
    process.env.KAELIX_SESSION_COOKIE = "dash_session=abc";
    console.warn = (message) => warnings.push(String(message));

    const client = createClientFromEnv();

    assert.equal(client.authMode, "cookie");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /local development only/);
  } finally {
    process.env = originalEnv;
    console.warn = originalWarn;
  }
});
