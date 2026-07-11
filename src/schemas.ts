import { z } from "zod";
import { KaelixApiError } from "./client.js";

// Validates the public JSON/HTTP response shape for the agent/task/task-log
// endpoints. `.passthrough()` on every object so additive backend fields
// don't break the adapter — only fields the adapter actually reads/forwards
// are strictly typed.

export const agentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    status: z.string(),
    provider: z.string(),
    model: z.string(),
    system_prompt: z.string().nullable().optional(),
    current_task_id: z.string().nullable().optional(),
    created_at: z.string(),
  })
  .passthrough();

export const taskLogSchema = z
  .object({
    id: z.string(),
    task_id: z.string(),
    level: z.string(),
    message: z.string(),
    created_at: z.string(),
  })
  .passthrough();

export const agentRunSchema = z
  .object({
    id: z.string(),
    task_id: z.string(),
    agent_id: z.string(),
    status: z.string(),
    started_at: z.string(),
    finished_at: z.string().nullable().optional(),
    tokens_used: z.number(),
    cost_usd: z.number(),
  })
  .passthrough();

export const taskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable().optional(),
    status: z.string(),
    priority: z.string(),
    assigned_agent_id: z.string().nullable().optional(),
    output: z.string().nullable().optional(),
    attachment_url: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    dependencies: z.array(z.string()).default([]),
    awaiting_approval: z.boolean().default(false),
    // Optimistic concurrency (backend 2026-07-10+). Older backends won't send
    // this field — default to 0 so callers on an old backend simply never get
    // a meaningful expectedRevision to round-trip (falls back to expectedStatus).
    revision: z.number().int().default(0),
  })
  .passthrough();

export const taskWithLogsSchema = taskSchema.extend({
  logs: z.array(taskLogSchema).default([]),
  runs: z.array(agentRunSchema).default([]),
});

export const providerHealthSchema = z.record(z.string(), z.unknown());

export const localAiStatusSchema = z
  .object({
    running: z.boolean(),
    base_url: z.string(),
    model_count: z.number().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const localAiModelsSchema = z
  .object({
    models: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export const localAiTestChatSchema = z
  .object({
    response: z.string(),
    model: z.string(),
  })
  .passthrough();

/**
 * Validates a raw (untrusted) backend response against a schema. A mismatch
 * is a `validation` KaelixApiError — the raw payload is never handed to the
 * caller unvalidated (see api-and-interface-design boundary rule C.3).
 */
export function parseBackendResponse<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new KaelixApiError(`Kaelix API response did not match the expected shape for ${path}.`, {
      kind: "validation",
      path,
    });
  }
  return result.data;
}

export const MAX_LIST_ITEMS = 200;

export interface TruncatedList<T> {
  items: T[];
  truncated: boolean;
  originalSize: number;
  returnedSize: number;
}

/**
 * The dashboard backend's list endpoints (GET /agents, GET /tasks) do not
 * support pagination query params today — see README "Known Limitations".
 * Until that lands, the adapter self-limits list size so a large dashboard
 * cannot blow past the response-size/context budget, and reports truncation
 * explicitly instead of silently dropping items.
 */
export function limitList<T>(items: T[], max = MAX_LIST_ITEMS): TruncatedList<T> {
  const originalSize = items.length;
  const limited = items.slice(0, max);
  return {
    items: limited,
    truncated: originalSize > limited.length,
    originalSize,
    returnedSize: limited.length,
  };
}
