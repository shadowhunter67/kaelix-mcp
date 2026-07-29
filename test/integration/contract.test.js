// Self-contained adapter <-> HTTP contract integration test.
//
// Unlike test/client.test.js / test/tools.test.js (which inject a fake
// `fetchImpl` function in-process), this drives the compiled adapter
// (dist/client.js + dist/tools.js + dist/capabilities.js) against a REAL
// loopback HTTP server (node:http, see mock-server.mjs) — proving the whole
// transport layer (real fetch, real headers, real redirects, real JSON
// parsing) works end-to-end, not just the classification logic.
//
// Replaces the previous run-adapter-backend-integration.mjs, which spawned
// the private Kaelix Dashboard's own FastAPI backend as a child process and
// therefore could not run in this public repo's CI (no sibling backend
// checkout exists there). This file has no dependency on any private
// backend: no spawned process, no database, no workspace-parent path, no
// network access beyond 127.0.0.1. Every server here only implements the
// adapter's public HTTP contract (same shapes validated in src/schemas.ts),
// not any private implementation.
//
// All tokens/cookies below are obviously-fake fixtures (never real
// credentials). The request recorder's summary() redacts Authorization/
// Cookie before it can appear in any assertion failure message.
import assert from "node:assert/strict";
import test from "node:test";
import { KaelixClient } from "../../dist/client.js";
import { approveTask, listAgents, rejectTask } from "../../dist/tools.js";
import { detectCapabilities } from "../../dist/capabilities.js";
import { createRecorder, recordRequest, sendJson, startMockServer } from "./mock-server.mjs";

const FIXTURE_TOKEN = "fixture-bearer-token-not-real";
const FIXTURE_COOKIE = "dash_session=fixture-cookie-value-not-real";

function fixtureTask(overrides = {}) {
  return {
    id: "task-1",
    title: "Fixture task",
    status: "reviewing",
    priority: "medium",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    revision: 0,
    ...overrides,
  };
}

function parseTool(result) {
  const body = JSON.parse(result.content[0].text);
  return { isError: result.isError === true, ...body };
}

async function withServer(requestListener, run) {
  const recorder = createRecorder();
  const server = await startMockServer((req, res, body) => {
    recordRequest(recorder, req, body);
    requestListener(req, res, body, recorder);
  });
  try {
    await run(server, recorder);
  } finally {
    await server.close();
  }
}

test("server binds loopback only, on a random port", async () => {
  await withServer(
    (req, res) => sendJson(res, 200, []),
    async (server) => {
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.notEqual(new URL(server.url).port, "0");
    },
  );
});

test("Bearer header is sent exactly as configured", async () => {
  await withServer(
    (req, res) => sendJson(res, 200, []),
    async (server, recorder) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      await client.request("/agents");
      assert.equal(
        recorder.last().headers.authorization,
        `Bearer ${FIXTURE_TOKEN}`,
        JSON.stringify(recorder.summary()),
      );
    },
  );
});

test("cookie is sent only when allowCookieAuth is opted in and no token is set", async () => {
  await withServer(
    (req, res) => sendJson(res, 200, []),
    async (server, recorder) => {
      const client = new KaelixClient({
        baseUrl: server.url,
        allowCookieAuth: true,
        sessionCookie: FIXTURE_COOKIE,
      });
      await client.request("/agents");
      assert.equal(recorder.last().headers.cookie, FIXTURE_COOKIE);
      assert.equal(recorder.last().headers.authorization, undefined);
    },
  );
});

test("cookie is NOT sent when allowCookieAuth is false, even if a cookie value is supplied", async () => {
  await withServer(
    (req, res) => sendJson(res, 200, []),
    async (server, recorder) => {
      const client = new KaelixClient({
        baseUrl: server.url,
        allowCookieAuth: false,
        sessionCookie: FIXTURE_COOKIE,
      });
      await client.request("/agents");
      assert.equal(recorder.last().headers.cookie, undefined);
    },
  );
});

test("Bearer/cookie precedence: token wins, cookie is never attached when both are configured", async () => {
  await withServer(
    (req, res) => sendJson(res, 200, []),
    async (server, recorder) => {
      const client = new KaelixClient({
        baseUrl: server.url,
        apiToken: FIXTURE_TOKEN,
        allowCookieAuth: true,
        sessionCookie: FIXTURE_COOKIE,
      });
      await client.request("/agents");
      assert.equal(recorder.last().headers.authorization, `Bearer ${FIXTURE_TOKEN}`);
      assert.equal(recorder.last().headers.cookie, undefined);
    },
  );
});

test("401 maps to auth error with isError:true", async () => {
  await withServer(
    (req, res) => sendJson(res, 401, { detail: "invalid or missing token" }),
    async (server) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      const result = parseTool(await listAgents(client));
      assert.equal(result.isError, true);
      assert.equal(result.error.kind, "auth");
      assert.equal(result.error.status, 401);
    },
  );
});

test("403 maps to forbidden error with isError:true", async () => {
  await withServer(
    (req, res) => sendJson(res, 403, { detail: "scope tasks:read required" }),
    async (server) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      const result = parseTool(await listAgents(client));
      assert.equal(result.isError, true);
      assert.equal(result.error.kind, "forbidden");
      assert.equal(result.error.status, 403);
    },
  );
});

test("stale expectedRevision: backend 409 maps to conflict with isError:true", async () => {
  await withServer(
    (req, res) => {
      if (req.method === "POST" && req.url.startsWith("/tasks/task-1/approve")) {
        return sendJson(res, 409, { detail: "revision 0 is stale, current revision is 1" });
      }
      sendJson(res, 404, { detail: "unexpected path in this test" });
    },
    async (server) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      const result = parseTool(
        await approveTask(client, { taskId: "task-1", expectedRevision: 0 }, "test-principal"),
      );
      assert.equal(result.isError, true);
      assert.equal(result.error.kind, "conflict");
      assert.equal(result.error.status, 409);
    },
  );
});

test("expectedRevision is forwarded as ?expected_revision= per the public contract", async () => {
  await withServer(
    (req, res) => {
      if (req.method === "POST" && req.url.startsWith("/tasks/task-1/approve")) {
        return sendJson(res, 200, fixtureTask({ status: "done", revision: 4 }));
      }
      sendJson(res, 404, { detail: "unexpected path" });
    },
    async (server, recorder) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      const result = parseTool(
        await approveTask(client, { taskId: "task-1", expectedRevision: 3 }, "test-principal"),
      );
      assert.equal(result.isError, false);
      assert.equal(recorder.last().search, "?expected_revision=3");
      assert.equal(recorder.last().path, "/tasks/task-1/approve");
    },
  );
});

test("reject also forwards ?expected_revision= exactly", async () => {
  await withServer(
    (req, res) => {
      if (req.method === "POST" && req.url.startsWith("/tasks/task-1/reject")) {
        return sendJson(res, 200, fixtureTask({ status: "failed", revision: 1 }));
      }
      sendJson(res, 404, { detail: "unexpected path" });
    },
    async (server, recorder) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      await rejectTask(
        client,
        { taskId: "task-1", reason: "not good", expectedRevision: 0 },
        "test-principal",
      );
      assert.equal(recorder.last().search, "?expected_revision=0");
    },
  );
});

test("429 is retried on GET and honors Retry-After: 0 without artificial delay", async () => {
  await withServer(
    (req, res, body, recorder) => {
      if (recorder.count === 1) {
        return sendJson(res, 429, { detail: "rate limited" }, { "Retry-After": "0" });
      }
      sendJson(res, 200, []);
    },
    async (server, recorder) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      const start = Date.now();
      const result = await client.request("/agents");
      assert.deepEqual(result, []);
      assert.equal(recorder.count, 2, "expected exactly one retry (2 total attempts)");
      assert.ok(Date.now() - start < 500, "Retry-After: 0 should not add a real delay");
    },
  );
});

test("GET retry is capped at 2 total attempts, then surfaces rate_limit", async () => {
  await withServer(
    (req, res) => sendJson(res, 429, { detail: "still limited" }, { "Retry-After": "0" }),
    async (server, recorder) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      await assert.rejects(
        () => client.request("/agents"),
        (err) => err.kind === "rate_limit",
      );
      assert.equal(recorder.count, 2, "adapter must not exceed its 2-attempt retry cap");
    },
  );
});

test("POST/write requests are never retried, even on a retryable 429", async () => {
  await withServer(
    (req, res) => sendJson(res, 429, { detail: "rate limited" }, { "Retry-After": "0" }),
    async (server, recorder) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      const result = parseTool(
        await approveTask(client, { taskId: "task-1", expectedRevision: 0 }, "test-principal"),
      );
      assert.equal(result.isError, true);
      assert.equal(result.error.kind, "rate_limit");
      assert.equal(recorder.count, 1, "a write request must be attempted exactly once, never retried");
    },
  );
});

test("cross-origin redirect strips Authorization and Cookie on the follow-up request", async () => {
  const targetRecorder = createRecorder();
  const target = await startMockServer((req, res, body) => {
    recordRequest(targetRecorder, req, body);
    sendJson(res, 200, []);
  });
  try {
    await withServer(
      (req, res) => {
        res.writeHead(302, { Location: `${target.url}/agents` });
        res.end();
      },
      async (server) => {
        const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
        await client.request("/agents");
        assert.equal(targetRecorder.count, 1, "redirect target should receive exactly one request");
        assert.equal(
          targetRecorder.last().headers.authorization,
          undefined,
          JSON.stringify(targetRecorder.summary()),
        );
        assert.equal(targetRecorder.last().headers.cookie, undefined);
      },
    );
  } finally {
    await target.close();
  }
});

test("a second redirect hop is not followed (MAX_REDIRECTS=1)", async () => {
  const finalRecorder = createRecorder();
  const finalServer = await startMockServer((req, res, body) => {
    recordRequest(finalRecorder, req, body);
    sendJson(res, 200, []);
  });
  const middleServer = await startMockServer((req, res) => {
    res.writeHead(302, { Location: `${finalServer.url}/agents` });
    res.end();
  });
  try {
    await withServer(
      (req, res) => {
        res.writeHead(302, { Location: `${middleServer.url}/agents` });
        res.end();
      },
      async (server) => {
        const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
        // Two hops requested (server -> middleServer -> finalServer), only
        // one is followed, so the final response is still middleServer's
        // 302, which the client does not treat as success.
        await assert.rejects(() => client.request("/agents"));
        assert.equal(finalRecorder.count, 0, "the second redirect hop must never be followed");
      },
    );
  } finally {
    await middleServer.close();
    await finalServer.close();
  }
});

test("capability discovery: 200 on /local-ai/status enables local-ai tools", async () => {
  await withServer(
    (req, res) => sendJson(res, 200, { running: true, base_url: "http://127.0.0.1:11434" }),
    async (server) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      const caps = await detectCapabilities(client, "auto");
      assert.equal(caps.localAi, true);
    },
  );
});

test("capability discovery: 404 on /local-ai/status disables local-ai tools (not advertised)", async () => {
  await withServer(
    (req, res) => sendJson(res, 404, { detail: "not found" }),
    async (server) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      const caps = await detectCapabilities(client, "auto");
      assert.equal(caps.localAi, false);
    },
  );
});

test("oversized response is rejected as response_too_large, not buffered", async () => {
  await withServer(
    (req, res) => {
      const big = "x".repeat(500);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(big);
    },
    async (server) => {
      const client = new KaelixClient({
        baseUrl: server.url,
        apiToken: FIXTURE_TOKEN,
        maxResponseBytes: 100,
      });
      await assert.rejects(
        () => client.request("/agents"),
        (err) => err.kind === "response_too_large",
      );
    },
  );
});

test("malformed (non-JSON) success response maps to a parse error", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{not valid json");
    },
    async (server) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      await assert.rejects(
        () => client.request("/agents"),
        (err) => err.kind === "parse",
      );
    },
  );
});

test("schema-invalid response (missing required fields) fails validation, not a crash", async () => {
  await withServer(
    (req, res) => sendJson(res, 200, [{ id: "agent-1" /* missing name/role/status/... */ }]),
    async (server) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      const result = parseTool(await listAgents(client));
      assert.equal(result.isError, true);
      assert.equal(result.error.kind, "validation");
    },
  );
});

test("redaction: a secret-shaped string in a backend error body never reaches the tool output", async () => {
  const leakedShape = "Bearer abcdefgh12345678";
  await withServer(
    (req, res) => sendJson(res, 401, { detail: `rejected token: ${leakedShape}` }),
    async (server) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      const result = await listAgents(client);
      const rawText = result.content[0].text;
      assert.ok(
        !rawText.includes("abcdefgh12345678"),
        "raw tool output must never contain the secret-shaped substring",
      );
      assert.ok(rawText.includes("[redacted]"), "redacted marker must be present in place of the secret");
    },
  );
});

test("correlationId is present, unique per call, and UUID-shaped on both success and error", async () => {
  await withServer(
    (req, res, body, recorder) => {
      if (recorder.count === 1) return sendJson(res, 200, []);
      sendJson(res, 401, { detail: "invalid token" });
    },
    async (server) => {
      const client = new KaelixClient({ baseUrl: server.url, apiToken: FIXTURE_TOKEN });
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      const ok = parseTool(await listAgents(client));
      assert.match(ok.correlationId, uuidRe);

      const err = parseTool(await listAgents(client));
      assert.match(err.correlationId, uuidRe);

      assert.notEqual(ok.correlationId, err.correlationId, "each tool call must get its own correlation id");
    },
  );
});
