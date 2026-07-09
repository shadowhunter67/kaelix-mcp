import assert from "node:assert/strict";
import test from "node:test";
import { KaelixApiError, KaelixClient } from "../dist/client.js";

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

test("supports local-dev cookie auth", async () => {
  let seenCookie = "";
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    sessionCookie: "kaelix_session=abc",
    fetchImpl: async (_url, init) => {
      seenCookie = new Headers(init?.headers).get("Cookie") || "";
      return response("{}", { status: 200 });
    },
  });

  await client.request("/tasks");
  assert.equal(seenCookie, "kaelix_session=abc");
});

test("returns undefined for 204 responses", async () => {
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    fetchImpl: async () => response("", { status: 204 }),
  });

  assert.equal(await client.request("/tasks/1/reject", { method: "POST" }), undefined);
});

test("classifies auth errors", async () => {
  const client = new KaelixClient({
    baseUrl: "http://localhost:8000/api",
    fetchImpl: async () => response('{"detail":"Not authenticated"}', { status: 401, statusText: "Unauthorized" }),
  });

  await assert.rejects(client.request("/agents"), (error) => {
    assert.equal(error instanceof KaelixApiError, true);
    assert.equal(error.kind, "auth");
    assert.equal(error.status, 401);
    assert.match(error.message, /Not authenticated/);
    return true;
  });
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
