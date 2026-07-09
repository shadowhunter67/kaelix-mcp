#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KaelixApiError, createClientFromEnv } from "./client.js";

const client = createClientFromEnv();

const server = new McpServer({
  name: "kaelix-mcp",
  version: "0.1.0",
});

function jsonText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function safeTool<T>(operation: () => Promise<T>) {
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

server.tool(
  "kaelix_server_info",
  "Show the current Kaelix MCP adapter configuration. Secrets are never returned.",
  {},
  async () =>
    jsonText({
      adapter: "kaelix-mcp",
      version: "0.1.0",
      apiUrl: client.baseUrl,
      authMode: client.authMode,
      timeoutMs: client.timeoutMs,
      note:
        client.authMode === "none"
          ? "No auth configured. Most dashboard endpoints require KAELIX_API_TOKEN. Cookie auth is local-dev only."
          : "Auth is configured.",
    }),
);

server.tool("kaelix_list_agents", "List agents from the Kaelix dashboard.", {}, async () => {
  return safeTool(() => client.request("/agents"));
});

server.tool("kaelix_list_tasks", "List tasks from the Kaelix dashboard.", {}, async () => {
  return safeTool(() => client.request("/tasks"));
});

server.tool(
  "kaelix_get_task",
  "Get a single task by id, including logs/runs if the backend returns them.",
  {
    taskId: z.string().min(1).describe("Kaelix task id"),
  },
  async ({ taskId }) => safeTool(() => client.request(`/tasks/${encodeURIComponent(taskId)}`)),
);

server.tool(
  "kaelix_create_task",
  "Create a pending task in Kaelix. This writes to the dashboard database but does not execute the task until run is requested.",
  {
    title: z.string().min(1).describe("Task title"),
    description: z.string().optional().describe("Task details"),
    priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    assignedAgentId: z.string().optional().describe("Optional agent id"),
  },
  async ({ title, description, priority, assignedAgentId }) =>
    safeTool(() =>
      client.request("/tasks", {
        method: "POST",
        body: JSON.stringify({
          title,
          description,
          priority,
          assigned_agent_id: assignedAgentId,
        }),
      }),
    ),
);

server.tool(
  "kaelix_run_task",
  "Queue an existing task for execution by its assigned agent. This can trigger external model/tool activity through the dashboard backend.",
  {
    taskId: z.string().min(1).describe("Kaelix task id"),
  },
  async ({ taskId }) =>
    safeTool(() =>
      client.request(`/tasks/${encodeURIComponent(taskId)}/run`, {
        method: "POST",
      }),
    ),
);

server.tool(
  "kaelix_approve_task",
  "Approve a task that is waiting for human review. Use only when the task output has been inspected and accepted.",
  {
    taskId: z.string().min(1).describe("Kaelix task id"),
  },
  async ({ taskId }) =>
    safeTool(() =>
      client.request(`/tasks/${encodeURIComponent(taskId)}/approve`, {
        method: "POST",
      }),
    ),
);

server.tool(
  "kaelix_reject_task",
  "Reject a task that is waiting for human review. Use when the output should not be accepted.",
  {
    taskId: z.string().min(1).describe("Kaelix task id"),
  },
  async ({ taskId }) =>
    safeTool(() =>
      client.request(`/tasks/${encodeURIComponent(taskId)}/reject`, {
        method: "POST",
      }),
    ),
);

server.tool("kaelix_provider_health", "Get configured provider health and cooldown state.", {}, async () => {
  return safeTool(() => client.request("/settings/provider-health"));
});

server.tool("kaelix_local_ai_status", "Check local AI/Ollama status if the dashboard exposes local-ai endpoints.", {}, async () => {
  return safeTool(() => client.request("/local-ai/status"));
});

server.tool("kaelix_local_ai_models", "List local AI/Ollama models if the dashboard exposes local-ai endpoints.", {}, async () => {
  return safeTool(() => client.request("/local-ai/models"));
});

server.tool(
  "kaelix_local_ai_test_chat",
  "Send a short test prompt to a local AI model if the dashboard exposes local-ai endpoints.",
  {
    model: z.string().min(1).describe("Local model name"),
    prompt: z.string().min(1).max(4000).describe("Short prompt to send to the local model"),
  },
  async ({ model, prompt }) =>
    safeTool(() =>
      client.request("/local-ai/test-chat", {
        method: "POST",
        body: JSON.stringify({ model, prompt }),
      }),
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
