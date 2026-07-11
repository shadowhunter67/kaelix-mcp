import assert from "node:assert/strict";
import test from "node:test";
import { KaelixApiError } from "../dist/client.js";
import {
  approveTask,
  createTask,
  getTask,
  listAgents,
  listTasks,
  rejectTask,
  runTask,
  safeTool,
} from "../dist/tools.js";

function parseTool(result) {
  return JSON.parse(result.content[0].text);
}

/** Every call returns the same `response` value (used for single-request tools). */
function recordingClient(response) {
  const calls = [];
  return {
    calls,
    client: {
      request: async (path, init = {}) => {
        calls.push({ path, init });
        return response;
      },
    },
  };
}

/** Each call returns the next value from `responses`, in order (used for multi-request flows like approve/reject). */
function queuedClient(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    client: {
      request: async (path, init = {}) => {
        calls.push({ path, init });
        return queue.shift();
      },
    },
  };
}

const AGENT = {
  id: "agent-1",
  name: "PM Bot",
  role: "orchestrator",
  status: "idle",
  provider: "groq",
  model: "llama-3.3-70b-versatile",
  system_prompt: null,
  current_task_id: null,
  created_at: "2026-07-10T00:00:00Z",
};

const TASK = {
  id: "task-1",
  title: "Fix settings",
  description: "Check MCP panel",
  status: "awaiting_review",
  priority: "high",
  assigned_agent_id: "agent-1",
  output: null,
  attachment_url: null,
  created_at: "2026-07-10T00:00:00Z",
  updated_at: "2026-07-10T00:00:00Z",
  dependencies: [],
  awaiting_approval: true,
};

test("createTask maps assignedAgentId to assigned_agent_id and wraps success in an envelope", async () => {
  const { client, calls } = recordingClient(TASK);

  const result = await createTask(
    client,
    {
      title: "Fix settings",
      description: "Check MCP panel",
      priority: "high",
      assignedAgentId: "agent-1",
      idempotencyKey: "idem-1",
    },
    "mcp:bearer",
  );

  const body = parseTool(result);
  assert.equal(result.isError, false);
  assert.equal(body.ok, true);
  assert.equal(typeof body.correlationId, "string");
  assert.equal(body.data.id, "task-1");
  assert.equal(calls[0].path, "/tasks");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Idempotency-Key"], "idem-1");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    title: "Fix settings",
    description: "Check MCP panel",
    priority: "high",
    assigned_agent_id: "agent-1",
  });
});

test("createTask dryRun does not call backend", async () => {
  const { client, calls } = recordingClient(TASK);

  const result = await createTask(client, { title: "Draft", priority: "medium", dryRun: true }, "mcp:bearer");

  const body = parseTool(result);
  assert.equal(body.ok, true);
  assert.equal(body.dryRun, true);
  assert.equal(body.plannedRequest.path, "/tasks");
  assert.equal(calls.length, 0);
});

test("runTask uses the expected POST path and idempotency header", async () => {
  const { client, calls } = recordingClient({ queued: true });

  await runTask(client, { taskId: "task/with spaces", idempotencyKey: "run-1" }, "mcp:bearer");

  assert.equal(calls[0].path, "/tasks/task%2Fwith%20spaces/run");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Idempotency-Key"], "run-1");
});

test("approveTask checks expectedStatus against live task state before mutating", async () => {
  const { client, calls } = queuedClient([TASK, { approved: true }]);

  const result = await approveTask(
    client,
    { taskId: "task-1", comment: "Looks good", expectedStatus: "awaiting_review" },
    "mcp:bearer",
  );

  assert.equal(parseTool(result).ok, true);
  assert.equal(calls[0].path, "/tasks/task-1");
  assert.equal(calls[1].path, "/tasks/task-1/approve");
  assert.deepEqual(JSON.parse(calls[1].init.body), { comment: "Looks good" });
});

test("approveTask fails with a conflict error when live status no longer matches expectedStatus", async () => {
  const { client, calls } = queuedClient([{ ...TASK, status: "done" }]);

  const result = await approveTask(
    client,
    { taskId: "task-1", expectedStatus: "awaiting_review" },
    "mcp:bearer",
  );

  const body = parseTool(result);
  assert.equal(result.isError, true);
  assert.equal(body.ok, false);
  assert.equal(body.error.kind, "conflict");
  // Only the status-check GET happened; the mutating approve call must not fire.
  assert.equal(calls.length, 1);
});

test("rejectTask sends required reason after the expectedStatus check", async () => {
  const { client, calls } = queuedClient([TASK, { rejected: true }]);

  await rejectTask(
    client,
    { taskId: "task-1", reason: "Output is incomplete", expectedStatus: "awaiting_review" },
    "mcp:bearer",
  );

  assert.equal(calls[1].path, "/tasks/task-1/reject");
  assert.deepEqual(JSON.parse(calls[1].init.body), { reason: "Output is incomplete" });
});

test("approveTask with expectedRevision forwards ?expected_revision= and skips the redundant status pre-read", async () => {
  const { client, calls } = recordingClient({ approved: true, revision: 4 });

  const result = await approveTask(client, { taskId: "task-1", expectedRevision: 3 }, "mcp:bearer");

  assert.equal(parseTool(result).ok, true);
  // Exactly one call: the atomic path does NOT do a GET pre-check first.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/tasks/task-1/approve?expected_revision=3");
  assert.equal(calls[0].init.method, "POST");
});

test("approveTask maps a backend 409 (stale expectedRevision) to a conflict isError result", async () => {
  const client = {
    request: async () => {
      throw new KaelixApiError("Task revision is 5, not the expected 3.", {
        kind: "conflict",
        path: "/tasks/task-1/approve",
        status: 409,
      });
    },
  };

  const result = await approveTask(client, { taskId: "task-1", expectedRevision: 3 }, "mcp:bearer");
  const body = parseTool(result);
  assert.equal(result.isError, true);
  assert.equal(body.ok, false);
  assert.equal(body.error.kind, "conflict");
  assert.equal(body.error.status, 409);
});

test("rejectTask with expectedRevision forwards the query param and skips the pre-read", async () => {
  const { client, calls } = recordingClient({ rejected: true });

  await rejectTask(client, { taskId: "task-1", reason: "bad output", expectedRevision: 7 }, "mcp:bearer");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/tasks/task-1/reject?expected_revision=7");
  assert.deepEqual(JSON.parse(calls[0].init.body), { reason: "bad output" });
});

test("approveTask accepts both expectedRevision and expectedStatus together (revision wins, no pre-read)", async () => {
  const { client, calls } = recordingClient({ approved: true });

  await approveTask(
    client,
    { taskId: "task-1", expectedStatus: "awaiting_review", expectedRevision: 2 },
    "mcp:bearer",
  );

  assert.equal(calls.length, 1); // no GET pre-check when a revision is supplied
  assert.equal(calls[0].path, "/tasks/task-1/approve?expected_revision=2");
});

test("approveTask rejects with a validation error when neither expectedStatus nor expectedRevision is given", async () => {
  const { client, calls } = recordingClient({ approved: true });

  const result = await approveTask(client, { taskId: "task-1" }, "mcp:bearer");
  const body = parseTool(result);

  assert.equal(result.isError, true);
  assert.equal(body.error.kind, "validation");
  assert.equal(calls.length, 0); // never even reaches the backend
});

test("rejectTask rejects with a validation error when neither confirmation field is given", async () => {
  const { client, calls } = recordingClient({ rejected: true });

  const result = await rejectTask(client, { taskId: "task-1", reason: "bad" }, "mcp:bearer");
  const body = parseTool(result);

  assert.equal(result.isError, true);
  assert.equal(body.error.kind, "validation");
  assert.equal(calls.length, 0);
});

test("listAgents validates and truncates the backend array", async () => {
  const { client } = recordingClient(Array.from({ length: 3 }, (_, i) => ({ ...AGENT, id: `agent-${i}` })));

  const result = await listAgents(client);
  const body = parseTool(result);
  assert.equal(body.ok, true);
  assert.equal(body.data.items.length, 3);
  assert.equal(body.data.truncated, false);
});

test("listAgents surfaces a validation error for a malformed backend item", async () => {
  const { client } = recordingClient([{ id: "a1" }]); // missing required fields

  const result = await listAgents(client);
  const body = parseTool(result);
  assert.equal(result.isError, true);
  assert.equal(body.ok, false);
  assert.equal(body.error.kind, "validation");
});

test("listTasks validates each item against the task schema", async () => {
  const { client } = recordingClient([TASK]);
  const result = await listTasks(client);
  const body = parseTool(result);
  assert.equal(body.data.items[0].id, "task-1");
});

test("getTask parses the taskWithLogs shape", async () => {
  const { client } = recordingClient({ ...TASK, logs: [], runs: [] });
  const result = await getTask(client, { taskId: "task-1" });
  const body = parseTool(result);
  assert.equal(body.data.id, "task-1");
});

test("safeTool returns MCP-friendly API error shape and sets isError", async () => {
  const result = await safeTool(async () => {
    throw new KaelixApiError("No auth", { kind: "auth", path: "/agents", status: 401 });
  });

  const body = parseTool(result);
  assert.equal(result.isError, true);
  assert.equal(body.ok, false);
  assert.equal(body.error.kind, "auth");
  assert.equal(body.error.status, 401);
  assert.equal(body.error.path, "/agents");
  assert.equal(body.error.message, "No auth");
  assert.equal(typeof body.correlationId, "string");
});

test("safeTool redacts secret-shaped fields even from unexpected (non-KaelixApiError) failures", async () => {
  const result = await safeTool(async () => {
    throw new Error('leaked token="abcdefgh12345678"');
  });

  const text = result.content[0].text;
  assert.equal(text.includes("abcdefgh12345678"), false);
});
