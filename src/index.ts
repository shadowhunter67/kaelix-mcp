#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClientFromEnv } from "./client.js";
import {
  approveTask,
  createTask,
  getTask,
  jsonText,
  listAgents,
  listTasks,
  localAiModels,
  localAiStatus,
  localAiTestChat,
  providerHealth,
  rejectTask,
  runTask,
} from "./tools.js";
import { ADAPTER_VERSION } from "./version.js";

const client = createClientFromEnv();

const server = new McpServer({
  name: "kaelix-mcp",
  version: ADAPTER_VERSION,
});

server.tool(
  "kaelix_server_info",
  "Show the current Kaelix MCP adapter configuration. Secrets are never returned.",
  {},
  async () =>
    jsonText({
      adapter: "kaelix-mcp",
      version: ADAPTER_VERSION,
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
  return listAgents(client);
});

server.tool("kaelix_list_tasks", "List tasks from the Kaelix dashboard.", {}, async () => {
  return listTasks(client);
});

server.tool(
  "kaelix_get_task",
  "Get a single task by id, including logs/runs if the backend returns them.",
  {
    taskId: z.string().min(1).describe("Kaelix task id"),
  },
  async ({ taskId }) => getTask(client, { taskId }),
);

server.tool(
  "kaelix_create_task",
  "Create a pending task in Kaelix. This writes to the dashboard database but does not execute the task until run is requested.",
  {
    title: z.string().min(1).describe("Task title"),
    description: z.string().optional().describe("Task details"),
    priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    assignedAgentId: z.string().optional().describe("Optional agent id"),
    idempotencyKey: z.string().optional().describe("Optional idempotency key forwarded as Idempotency-Key."),
    dryRun: z.boolean().default(false).describe("Preview the request without writing to the dashboard."),
  },
  async (args) => createTask(client, args),
);

server.tool(
  "kaelix_run_task",
  "Queue an existing task for execution by its assigned agent. This can trigger external model/tool activity through the dashboard backend.",
  {
    taskId: z.string().min(1).describe("Kaelix task id"),
    idempotencyKey: z.string().optional().describe("Optional idempotency key forwarded as Idempotency-Key."),
    dryRun: z.boolean().default(false).describe("Preview the request without queueing the task."),
  },
  async (args) => runTask(client, args),
);

server.tool(
  "kaelix_approve_task",
  "Approve a task that is waiting for human review. Use only when the task output has been inspected and accepted.",
  {
    taskId: z.string().min(1).describe("Kaelix task id"),
    comment: z.string().optional().describe("Optional audit comment explaining the approval."),
  },
  async (args) => approveTask(client, args),
);

server.tool(
  "kaelix_reject_task",
  "Reject a task that is waiting for human review. Use when the output should not be accepted.",
  {
    taskId: z.string().min(1).describe("Kaelix task id"),
    reason: z.string().min(1).describe("Required audit reason for rejecting the task output."),
  },
  async (args) => rejectTask(client, args),
);

server.tool("kaelix_provider_health", "Get configured provider health and cooldown state.", {}, async () => {
  return providerHealth(client);
});

server.tool(
  "kaelix_local_ai_status",
  "Check local AI/Ollama status if the dashboard exposes local-ai endpoints.",
  {},
  async () => {
    return localAiStatus(client);
  },
);

server.tool(
  "kaelix_local_ai_models",
  "List local AI/Ollama models if the dashboard exposes local-ai endpoints.",
  {},
  async () => {
    return localAiModels(client);
  },
);

server.tool(
  "kaelix_local_ai_test_chat",
  "Send a short test prompt to a local AI model if the dashboard exposes local-ai endpoints.",
  {
    model: z.string().min(1).describe("Local model name"),
    prompt: z.string().min(1).max(4000).describe("Short prompt to send to the local model"),
  },
  async (args) => localAiTestChat(client, args),
);

const transport = new StdioServerTransport();
await server.connect(transport);
