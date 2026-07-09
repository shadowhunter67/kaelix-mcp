# Kaelix MCP Adapter

[![npm version](https://img.shields.io/npm/v/kaelix-mcp.svg)](https://www.npmjs.com/package/kaelix-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Kaelix MCP Adapter lets Claude, Codex, Cursor, and other MCP clients control a
self-hosted Kaelix Dashboard instance through MCP tools.

This repository contains only the public MCP adapter. It does not include the
Kaelix dashboard frontend, backend, database, prompts, credentials, or private
business logic. Users run their own dashboard and point this adapter at their
own local or self-hosted Kaelix API.

## Project Status

This is a personal project and an early public MCP adapter for Kaelix. It is
usable for testing, but the dashboard API contract and tool surface may still
change. Bug reports, setup feedback, and pull requests are welcome.

Current release:

- npm package: `kaelix-mcp`
- latest version: `0.1.0`
- license: MIT
- runtime: Node.js 22.6 or newer

## What It Does

The adapter exposes Kaelix Dashboard actions as MCP tools:

- Read agents and tasks.
- Create, run, approve, and reject tasks.
- Check provider health.
- Check local AI / Ollama status when the dashboard supports it.
- Return structured, agent-friendly errors instead of raw backend failures.

Write tools can change dashboard state. MCP clients and users should treat this
adapter like an automation client with real side effects.

## Screenshots

The MCP adapter is designed to control a self-hosted Kaelix Dashboard instance
like the one below.

![Kaelix dashboard overview](docs/images/dashboard.png)

| Agents                                        | Tasks                                       |
| --------------------------------------------- | ------------------------------------------- |
| ![Kaelix agents view](docs/images/agents.png) | ![Kaelix tasks view](docs/images/tasks.png) |

| Relay cockpit                               | Local AI                                          |
| ------------------------------------------- | ------------------------------------------------- |
| ![Kaelix Relay view](docs/images/relay.png) | ![Kaelix Local AI view](docs/images/local-ai.png) |

![Kaelix Settings MCP service-token config](docs/images/settings-mcp.png)

## Requirements

- Node.js 22.6 or newer.
- A running Kaelix Dashboard backend, usually `http://localhost:8000/api`.
- A dashboard service token set in `KAELIX_API_TOKEN`.
- Optional timeout override with `KAELIX_TIMEOUT_MS`, default `20000`.

The recommended auth mode is Bearer service-token auth:

```env
KAELIX_API_URL=http://localhost:8000/api
KAELIX_API_TOKEN=replace-with-service-token
```

Cookie auth exists only as a local development fallback:

```env
KAELIX_ALLOW_COOKIE_AUTH=true
KAELIX_SESSION_COOKIE=kaelix_session=...
```

Do not use cookie auth on shared machines, CI, remote MCP servers, synced config
folders, or public examples. Never publish real tokens or cookies.

## Quick Start

Use the published npm package from an MCP client:

```json
{
  "mcpServers": {
    "kaelix": {
      "command": "npx",
      "args": ["-y", "kaelix-mcp"],
      "env": {
        "KAELIX_API_URL": "http://localhost:8000/api",
        "KAELIX_API_TOKEN": "replace-with-service-token"
      }
    }
  }
}
```

Then restart your MCP client and ask it to call `kaelix_server_info` first. That
tool confirms the adapter can read its config and shows which auth mode is
active without exposing secrets.

## Client Examples

Example config files are included in:

- `examples/claude-desktop.json`
- `examples/cursor.json`

Most MCP clients use the same shape:

```json
{
  "mcpServers": {
    "kaelix": {
      "command": "npx",
      "args": ["-y", "kaelix-mcp"],
      "env": {
        "KAELIX_API_URL": "http://localhost:8000/api",
        "KAELIX_API_TOKEN": "replace-with-service-token"
      }
    }
  }
}
```

For local adapter development, run the built file directly:

```json
{
  "mcpServers": {
    "kaelix": {
      "command": "node",
      "args": ["/absolute/path/to/kaelix-mcp/dist/index.js"],
      "env": {
        "KAELIX_API_URL": "http://localhost:8000/api",
        "KAELIX_API_TOKEN": "replace-with-service-token"
      }
    }
  }
}
```

## Architecture

```text
MCP client
  -> npx kaelix-mcp
  -> KAELIX_API_URL
  -> self-hosted Kaelix Dashboard backend
```

The adapter talks to the dashboard HTTP API. It does not host a server, store a
database, or call AI providers directly.

## Tools

| Tool                        | Purpose                                  | Side effect |
| --------------------------- | ---------------------------------------- | ----------- |
| `kaelix_server_info`        | Show adapter config and auth mode        | No          |
| `kaelix_list_agents`        | List dashboard agents                    | No          |
| `kaelix_list_tasks`         | List tasks                               | No          |
| `kaelix_get_task`           | Get one task                             | No          |
| `kaelix_create_task`        | Create a pending task                    | Yes         |
| `kaelix_run_task`           | Queue task execution                     | Yes         |
| `kaelix_approve_task`       | Approve reviewed task output             | Yes         |
| `kaelix_reject_task`        | Reject reviewed task output              | Yes         |
| `kaelix_provider_health`    | Read provider health and cooldown status | No          |
| `kaelix_local_ai_status`    | Check local AI / Ollama status           | No          |
| `kaelix_local_ai_models`    | List local AI models                     | No          |
| `kaelix_local_ai_test_chat` | Send a short local model test prompt     | Yes         |

Task write tools support guardrail fields where relevant:

- `kaelix_create_task`: supports `dryRun` and `idempotencyKey`.
- `kaelix_run_task`: supports `dryRun` and `idempotencyKey`.
- `kaelix_approve_task`: accepts optional `comment`.
- `kaelix_reject_task`: requires `reason`.

## Tool Contract For AI Agents

Use this order when possible:

1. Call `kaelix_server_info` to confirm config.
2. Call read-only tools before write tools.
3. Use `dryRun: true` before `kaelix_create_task` or `kaelix_run_task` when the
   user has not clearly approved the action.
4. Use `idempotencyKey` for task creation and execution if the client may retry.
5. Ask for human confirmation before running, approving, or rejecting important
   tasks.
6. Never expose `KAELIX_API_TOKEN`, `KAELIX_SESSION_COOKIE`, or backend secrets
   in responses.

All tool responses are JSON text. API failures return this shape:

```json
{
  "ok": false,
  "error": {
    "kind": "auth",
    "status": 401,
    "path": "/tasks",
    "message": "Kaelix API returned 401 Unauthorized."
  }
}
```

Possible `error.kind` values:

- `auth`
- `not_found`
- `validation`
- `timeout`
- `network`
- `backend`
- `parse`
- `unexpected`

## Backend API Contract

| Tool                        | Method | Backend path                | Auth     |
| --------------------------- | ------ | --------------------------- | -------- |
| `kaelix_list_agents`        | `GET`  | `/agents`                   | Required |
| `kaelix_list_tasks`         | `GET`  | `/tasks`                    | Required |
| `kaelix_get_task`           | `GET`  | `/tasks/:taskId`            | Required |
| `kaelix_create_task`        | `POST` | `/tasks`                    | Required |
| `kaelix_run_task`           | `POST` | `/tasks/:taskId/run`        | Required |
| `kaelix_approve_task`       | `POST` | `/tasks/:taskId/approve`    | Required |
| `kaelix_reject_task`        | `POST` | `/tasks/:taskId/reject`     | Required |
| `kaelix_provider_health`    | `GET`  | `/settings/provider-health` | Required |
| `kaelix_local_ai_status`    | `GET`  | `/local-ai/status`          | Required |
| `kaelix_local_ai_models`    | `GET`  | `/local-ai/models`          | Required |
| `kaelix_local_ai_test_chat` | `POST` | `/local-ai/test-chat`       | Required |

The `local_ai` tools require matching `/api/local-ai/*` endpoints in the
dashboard backend. If the user's dashboard version does not expose those
endpoints yet, the adapter returns a clear API error instead of crashing.

## Backend Service Token

Kaelix Dashboard should expose service-token auth for MCP clients. Set this in
the dashboard backend `.env`:

```env
KAELIX_MCP_TOKEN=generated-secret
```

The adapter then sends:

```http
Authorization: Bearer generated-secret
```

The dashboard can expose a status endpoint that confirms whether MCP auth is
configured without returning the token:

```http
GET /api/auth/mcp-status
-> { "enabled": true, "auth_type": "bearer" }
```

Generate a token locally and never commit it:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

## Local Development

```bash
npm install
npm run build
npm test
```

Useful scripts:

```bash
npm run format:check
npm run typecheck
npm run build
npm test
```

Test the published package metadata:

```bash
npm view kaelix-mcp version
```

Run the published package:

```bash
npx -y kaelix-mcp
```

The `npx` command starts an MCP server over stdio, so it may appear to wait for
client input. That is expected.

## Troubleshooting

`kaelix_server_info` shows `authMode: "none"`:

- Set `KAELIX_API_TOKEN`.
- Confirm the MCP client config restarted.

Tool returns `error.kind: "network"`:

- Confirm the dashboard backend is running.
- Check `KAELIX_API_URL`, usually `http://localhost:8000/api`.

Tool returns `error.kind: "auth"`:

- Confirm the dashboard backend has `KAELIX_MCP_TOKEN`.
- Confirm `KAELIX_API_TOKEN` matches that value.
- Avoid cookie auth unless this is local-only development.

Local AI tools return `not_found`:

- Your dashboard build may not include `/api/local-ai/*` yet.
- Update the dashboard backend or use non-local-AI tools first.

## Open-Source Boundary

Recommended split:

```text
kaelix-dashboard/   private or community dashboard
kaelix-mcp/         public MCP adapter
```

The public adapter should contain API contracts, tool definitions, examples,
tests, and docs. It should not contain private dashboard internals.

## CI/CD And Release

This repository has two GitHub Actions workflows:

- `CI`: runs on pushes and pull requests to `main`.
- `Release`: verifies the package, creates an npm tarball artifact, and
  publishes to npm when a GitHub Release is published.

The release pipeline runs:

```bash
npm ci
npm run format:check
npm run typecheck
npm run build
npm test
npm pack
```

Publishing uses npm provenance:

```bash
npm publish --provenance --access public
```

Requirements for publishing:

- GitHub repository must be public when provenance is enabled.
- GitHub secret `NPM_TOKEN` must exist.
- npm token must have package read/write permission.
- If npm 2FA is enabled, the token must support publish automation.

## Public Release Checklist

- [x] Add backend service-token support.
- [x] Confirm every tool maps to a dashboard API endpoint.
- [x] Add screenshots to the public README.
- [x] Add CI for format, typecheck, build, and tests.
- [x] Add release workflow with npm package artifact.
- [x] Add `NPM_TOKEN` and publish `kaelix-mcp` to npm.
- [x] Keep `.env`, tokens, cookies, and dashboard databases out of the repo.
