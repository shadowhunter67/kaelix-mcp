import { KaelixApiError } from "./client.js";

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

export interface ApproveTaskArgs extends TaskIdArgs {
  comment?: string;
}

export interface RejectTaskArgs extends TaskIdArgs {
  reason: string;
}

export function jsonText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export async function safeTool<T>(operation: () => Promise<T>) {
  try {
    return jsonText(await operation());
  } catch (error) {
    const message =
      error instanceof KaelixApiError
        ? {
            ok: false,
            error: {
              kind: error.kind,
              status: error.status,
              path: error.path,
              message: error.message,
            },
          }
        : {
            ok: false,
            error: {
              kind: "unexpected",
              message: error instanceof Error ? error.message : String(error),
            },
          };
    return jsonText(message);
  }
}

export function listAgents(client: KaelixApiLike) {
  return safeTool(() => client.request("/agents"));
}

export function listTasks(client: KaelixApiLike) {
  return safeTool(() => client.request("/tasks"));
}

export function getTask(client: KaelixApiLike, { taskId }: TaskIdArgs) {
  return safeTool(() => client.request(`/tasks/${encodeURIComponent(taskId)}`));
}

export function createTask(client: KaelixApiLike, args: CreateTaskArgs) {
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
    return jsonText({ ok: true, dryRun: true, plannedRequest: request });
  }

  return safeTool(() => client.request(request.path, request.init));
}

export function runTask(client: KaelixApiLike, args: RunTaskArgs) {
  const request = {
    path: `/tasks/${encodeURIComponent(args.taskId)}/run`,
    init: {
      method: "POST",
      headers: idempotencyHeaders(args.idempotencyKey),
    },
  };

  if (args.dryRun) {
    return jsonText({ ok: true, dryRun: true, plannedRequest: request });
  }

  return safeTool(() => client.request(request.path, request.init));
}

export function approveTask(client: KaelixApiLike, { taskId, comment }: ApproveTaskArgs) {
  return safeTool(() =>
    client.request(`/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: "POST",
      body: comment ? JSON.stringify({ comment }) : undefined,
    }),
  );
}

export function rejectTask(client: KaelixApiLike, { taskId, reason }: RejectTaskArgs) {
  return safeTool(() =>
    client.request(`/tasks/${encodeURIComponent(taskId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  );
}

export function providerHealth(client: KaelixApiLike) {
  return safeTool(() => client.request("/settings/provider-health"));
}

export function localAiStatus(client: KaelixApiLike) {
  return safeTool(() => client.request("/local-ai/status"));
}

export function localAiModels(client: KaelixApiLike) {
  return safeTool(() => client.request("/local-ai/models"));
}

export function localAiTestChat(client: KaelixApiLike, args: { model: string; prompt: string }) {
  return safeTool(() =>
    client.request("/local-ai/test-chat", {
      method: "POST",
      body: JSON.stringify(args),
    }),
  );
}

function idempotencyHeaders(idempotencyKey?: string): HeadersInit | undefined {
  return idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
}
