import assert from "node:assert/strict";
import test from "node:test";
import { KaelixApiError } from "../dist/client.js";
import { agentSchema, limitList, parseBackendResponse, taskSchema } from "../dist/schemas.js";

test("parseBackendResponse accepts a well-formed agent and tolerates extra fields", () => {
  const raw = {
    id: "a1",
    name: "PM Bot",
    role: "orchestrator",
    status: "idle",
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    system_prompt: null,
    current_task_id: null,
    created_at: "2026-07-10T00:00:00Z",
    somethingBackendAddedLater: 42,
  };
  const parsed = parseBackendResponse(agentSchema, raw, "/agents[0]");
  assert.equal(parsed.id, "a1");
  assert.equal(parsed.somethingBackendAddedLater, 42);
});

test("parseBackendResponse rejects a malformed/schema-mismatched agent", () => {
  const raw = { id: "a1", name: "PM Bot" }; // missing required fields
  assert.throws(
    () => parseBackendResponse(agentSchema, raw, "/agents[0]"),
    (error) => error instanceof KaelixApiError && error.kind === "validation",
  );
});

test("parseBackendResponse rejects malformed JSON shapes (wrong type)", () => {
  assert.throws(
    () => parseBackendResponse(taskSchema, "not-an-object", "/tasks[0]"),
    (error) => error instanceof KaelixApiError && error.kind === "validation",
  );
});

test("taskSchema defaults dependencies/awaiting_approval when omitted", () => {
  const parsed = parseBackendResponse(
    taskSchema,
    {
      id: "t1",
      title: "Do the thing",
      status: "pending",
      priority: "medium",
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    },
    "/tasks[0]",
  );
  assert.deepEqual(parsed.dependencies, []);
  assert.equal(parsed.awaiting_approval, false);
});

test("limitList caps items and reports truncation metadata", () => {
  const items = Array.from({ length: 5 }, (_, i) => i);
  const result = limitList(items, 3);
  assert.deepEqual(result.items, [0, 1, 2]);
  assert.equal(result.truncated, true);
  assert.equal(result.originalSize, 5);
  assert.equal(result.returnedSize, 3);
});

test("limitList reports no truncation when under the cap", () => {
  const result = limitList([1, 2], 3);
  assert.equal(result.truncated, false);
  assert.equal(result.originalSize, 2);
  assert.equal(result.returnedSize, 2);
});
