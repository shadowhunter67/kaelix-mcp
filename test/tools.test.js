import assert from "node:assert/strict";
import test from "node:test";
import { KaelixApiError } from "../dist/client.js";
import { approveTask, createTask, rejectTask, runTask, safeTool } from "../dist/tools.js";

function parseTool(result) {
  return JSON.parse(result.content[0].text);
}

function recordingClient(response = { ok: true }) {
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

test("createTask maps assignedAgentId to assigned_agent_id", async () => {
  const { client, calls } = recordingClient({ id: "task-1" });

  const result = await createTask(client, {
    title: "Fix settings",
    description: "Check MCP panel",
    priority: "high",
    assignedAgentId: "agent-1",
    idempotencyKey: "idem-1",
  });

  assert.deepEqual(parseTool(result), { id: "task-1" });
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
  const { client, calls } = recordingClient();

  const result = await createTask(client, {
    title: "Draft",
    priority: "medium",
    dryRun: true,
  });

  const body = parseTool(result);
  assert.equal(body.ok, true);
  assert.equal(body.dryRun, true);
  assert.equal(body.plannedRequest.path, "/tasks");
  assert.equal(calls.length, 0);
});

test("runTask uses the expected POST path and idempotency header", async () => {
  const { client, calls } = recordingClient({ queued: true });

  await runTask(client, { taskId: "task/with spaces", idempotencyKey: "run-1" });

  assert.equal(calls[0].path, "/tasks/task%2Fwith%20spaces/run");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Idempotency-Key"], "run-1");
});

test("approveTask sends optional comment", async () => {
  const { client, calls } = recordingClient({ approved: true });

  await approveTask(client, { taskId: "task-1", comment: "Looks good" });

  assert.equal(calls[0].path, "/tasks/task-1/approve");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { comment: "Looks good" });
});

test("rejectTask sends required reason", async () => {
  const { client, calls } = recordingClient({ rejected: true });

  await rejectTask(client, { taskId: "task-1", reason: "Output is incomplete" });

  assert.equal(calls[0].path, "/tasks/task-1/reject");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { reason: "Output is incomplete" });
});

test("safeTool returns MCP-friendly API error shape", async () => {
  const result = await safeTool(async () => {
    throw new KaelixApiError("No auth", { kind: "auth", path: "/agents", status: 401 });
  });

  assert.deepEqual(parseTool(result), {
    ok: false,
    error: {
      kind: "auth",
      status: 401,
      path: "/agents",
      message: "No auth",
    },
  });
});
