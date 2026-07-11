import { randomUUID } from "node:crypto";
import { KaelixApiError } from "./client.js";
import { redactValue } from "./redact.js";
import {
  agentSchema,
  limitList,
  localAiModelsSchema,
  localAiStatusSchema,
  localAiTestChatSchema,
  parseBackendResponse,
  providerHealthSchema,
  taskSchema,
  taskWithLogsSchema,
} from "./schemas.js";

export interface KaelixApiLike {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

export interface CreateTaskArgs {
  title: string;
  description?: string;
  priority: "low" | "medium" | "high" | "urgent";
  assignedAgentId?: string;
  idempotencyKey?: string;
  dryRun?: boolean;
}

export interface TaskIdArgs {
  taskId: string;
}

export interface RunTaskArgs extends TaskIdArgs {
  idempotencyKey?: string;
  dryRun?: boolean;
}

/**
 * Confirmation boundary for approve/reject. Provide at least one:
 *  - `expectedRevision` (preferred): forwarded to the backend as
 *    `?expected_revision=`, checked atomically in the same DB transaction as
 *    the write. Backend returns 409 (mapped to `conflict`) on a stale value.
 *    Requires a backend that returns `revision` on tasks (2026-07-10+).
 *  - `expectedStatus` (legacy fallback, kept for backward compatibility with
 *    older backends/callers): the adapter re-reads the task immediately
 *    before mutating it and fails with `conflict` if the live status no
 *    longer matches. This is a best-effort, non-atomic guard (TOCTOU race)
 *    — NOT a substitute for `expectedRevision` when the backend supports it.
 * Supplying neither is rejected — approve/reject always require an explicit
 * confirmation boundary enforced in code, not just tool-description text.
 */
export interface ConfirmationArgs {
  expectedStatus?: string;
  expectedRevision?: number;
}

export interface ApproveTaskArgs extends TaskIdArgs, ConfirmationArgs {
  comment?: string;
}

export interface RejectTaskArgs extends TaskIdArgs, ConfirmationArgs {
  reason: string;
}

export function jsonText(value: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    isError,
  };
}

function errorPayload(error: unknown, correlationId: string) {
  if (error instanceof KaelixApiError) {
    return {
      ok: false as const,
      correlationId,
      error: {
        kind: error.kind,
        status: error.status,
        path: error.path,
        message: error.message,
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false as const,
    correlationId,
    error: { kind: "unexpected" as const, message },
  };
}

/**
 * Runs a tool operation and normalizes both success and failure into the
 * adapter's response envelope. Failures set `isError: true` (MCP SDK error
 * signaling) so clients/telemetry cannot mistake an error for a successful
 * result, and every payload is redacted before serialization as defense in
 * depth against secrets leaking into tool output.
 */
export async function safeTool<T>(operation: () => Promise<T>) {
  const correlationId = randomUUID();
  try {
    const data = await operation();
    return jsonText(redactValue({ ok: true, correlationId, data }));
  } catch (error) {
    return jsonText(redactValue(errorPayload(error, correlationId)), true);
  }
}

/** Emits a secret-free audit line to stderr for write actions (stdout is the MCP protocol channel). */
function auditWrite(action: string, resource: string, principal: string): void {
  const event = {
    type: "kaelix_mcp_audit",
    action,
    resource,
    principal,
    timestamp: new Date().toISOString(),
  };
  console.error(JSON.stringify(event));
}

export function listAgents(client: KaelixApiLike) {
  return safeTool(async () => {
    const raw = await client.request<unknown[]>("/agents");
    const agents = raw.map((item, i) => parseBackendResponse(agentSchema, item, `/agents[${i}]`));
    return limitList(agents);
  });
}

export function listTasks(client: KaelixApiLike) {
  return safeTool(async () => {
    const raw = await client.request<unknown[]>("/tasks");
    const tasks = raw.map((item, i) => parseBackendResponse(taskSchema, item, `/tasks[${i}]`));
    return limitList(tasks);
  });
}

export function getTask(client: KaelixApiLike, { taskId }: TaskIdArgs) {
  return safeTool(async () => {
    const raw = await client.request(`/tasks/${encodeURIComponent(taskId)}`);
    return parseBackendResponse(taskWithLogsSchema, raw, `/tasks/${taskId}`);
  });
}

export function createTask(client: KaelixApiLike, args: CreateTaskArgs, principal: string) {
  const request = {
    path: "/tasks",
    init: {
      method: "POST",
      headers: idempotencyHeaders(args.idempotencyKey),
      body: JSON.stringify({
        title: args.title,
        description: args.description,
        priority: args.priority,
        assigned_agent_id: args.assignedAgentId,
      }),
    },
  };

  if (args.dryRun) {
    return jsonText(
      redactValue({ ok: true, correlationId: randomUUID(), dryRun: true, plannedRequest: request }),
    );
  }

  return safeTool(async () => {
    const raw = await client.request(request.path, request.init);
    auditWrite("create_task", request.path, principal);
    return parseBackendResponse(taskSchema, raw, request.path);
  });
}

export function runTask(client: KaelixApiLike, args: RunTaskArgs, principal: string) {
  const request = {
    path: `/tasks/${encodeURIComponent(args.taskId)}/run`,
    init: {
      method: "POST",
      headers: idempotencyHeaders(args.idempotencyKey),
    },
  };

  if (args.dryRun) {
    return jsonText(
      redactValue({ ok: true, correlationId: randomUUID(), dryRun: true, plannedRequest: request }),
    );
  }

  return safeTool(async () => {
    const result = await client.request(request.path, request.init);
    auditWrite("run_task", request.path, principal);
    return result;
  });
}

/**
 * Checks the task's live status against the caller's `expectedStatus` before
 * approving/rejecting. This is a confirmation boundary enforced in code (not
 * just tool description text) but it is NOT atomic: another writer could
 * change the status between this check and the mutating request below
 * (TOCTOU). Only used when the caller didn't provide `expectedRevision` —
 * when they did, the backend enforces the check atomically instead (see
 * `revisionQuery` below), making this pre-check redundant in that case.
 */
async function assertExpectedStatus(
  client: KaelixApiLike,
  taskId: string,
  expectedStatus: string,
): Promise<void> {
  const raw = await client.request(`/tasks/${encodeURIComponent(taskId)}`);
  const task = parseBackendResponse(taskWithLogsSchema, raw, `/tasks/${taskId}`);
  if (task.status !== expectedStatus) {
    throw new KaelixApiError(
      `Task ${taskId} status is "${task.status}", not the expected "${expectedStatus}". Re-read the task before retrying.`,
      { kind: "conflict", path: `/tasks/${taskId}` },
    );
  }
}

function requireConfirmation({ expectedStatus, expectedRevision }: ConfirmationArgs, taskId: string): void {
  if (expectedStatus === undefined && expectedRevision === undefined) {
    throw new KaelixApiError(
      `Refusing to approve/reject task ${taskId} without a confirmation boundary: ` +
        "provide expectedRevision (preferred, atomic — read it via kaelix_get_task) " +
        "and/or expectedStatus.",
      { kind: "validation", path: `/tasks/${taskId}` },
    );
  }
}

function revisionQuery(expectedRevision: number | undefined): string {
  return expectedRevision !== undefined
    ? `?expected_revision=${encodeURIComponent(String(expectedRevision))}`
    : "";
}

export function approveTask(
  client: KaelixApiLike,
  { taskId, comment, expectedStatus, expectedRevision }: ApproveTaskArgs,
  principal: string,
) {
  return safeTool(async () => {
    requireConfirmation({ expectedStatus, expectedRevision }, taskId);
    // Atomic path (expectedRevision) skips the redundant non-atomic pre-read —
    // the backend enforces it in the same transaction as the write and
    // returns 409 (mapped to `conflict`) on a stale revision.
    if (expectedRevision === undefined && expectedStatus !== undefined) {
      await assertExpectedStatus(client, taskId, expectedStatus);
    }
    const result = await client.request(
      `/tasks/${encodeURIComponent(taskId)}/approve${revisionQuery(expectedRevision)}`,
      { method: "POST", body: comment ? JSON.stringify({ comment }) : undefined },
    );
    auditWrite("approve_task", `/tasks/${taskId}/approve`, principal);
    return result;
  });
}

export function rejectTask(
  client: KaelixApiLike,
  { taskId, reason, expectedStatus, expectedRevision }: RejectTaskArgs,
  principal: string,
) {
  return safeTool(async () => {
    requireConfirmation({ expectedStatus, expectedRevision }, taskId);
    if (expectedRevision === undefined && expectedStatus !== undefined) {
      await assertExpectedStatus(client, taskId, expectedStatus);
    }
    const result = await client.request(
      `/tasks/${encodeURIComponent(taskId)}/reject${revisionQuery(expectedRevision)}`,
      { method: "POST", body: JSON.stringify({ reason }) },
    );
    auditWrite("reject_task", `/tasks/${taskId}/reject`, principal);
    return result;
  });
}

export function providerHealth(client: KaelixApiLike) {
  return safeTool(async () => {
    const raw = await client.request("/settings/provider-health");
    return parseBackendResponse(providerHealthSchema, raw, "/settings/provider-health");
  });
}

export function localAiStatus(client: KaelixApiLike) {
  return safeTool(async () => {
    const raw = await client.request("/local-ai/status");
    return parseBackendResponse(localAiStatusSchema, raw, "/local-ai/status");
  });
}

export function localAiModels(client: KaelixApiLike) {
  return safeTool(async () => {
    const raw = await client.request("/local-ai/models");
    return parseBackendResponse(localAiModelsSchema, raw, "/local-ai/models");
  });
}

export function localAiTestChat(
  client: KaelixApiLike,
  args: { model: string; prompt: string },
  principal: string,
) {
  return safeTool(async () => {
    const raw = await client.request("/local-ai/test-chat", {
      method: "POST",
      body: JSON.stringify(args),
    });
    auditWrite("local_ai_test_chat", "/local-ai/test-chat", principal);
    return parseBackendResponse(localAiTestChatSchema, raw, "/local-ai/test-chat");
  });
}

function idempotencyHeaders(idempotencyKey?: string): HeadersInit | undefined {
  return idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
}
