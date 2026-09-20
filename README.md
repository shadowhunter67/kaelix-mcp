# Kaelix MCP Adapter

[![CI](https://github.com/shadowhunter67/kaelix-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/shadowhunter67/kaelix-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/kaelix-mcp.svg)](https://www.npmjs.com/package/kaelix-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A small [MCP](https://modelcontextprotocol.io) server that lets AI agents (Claude, Codex, Cursor, ...)
read, create, run, approve and reject tasks on a self-hosted **Kaelix Dashboard**, safely.

```text
AI agent  --MCP-->  kaelix-mcp  --HTTPS API-->  Kaelix Dashboard
```

This repo contains only the adapter. You run your own dashboard and point the adapter at it.

## Why

Without an adapter, an AI agent can only suggest text. With it, the agent can work on the
task board directly, while the adapter keeps the risky parts under control:

- **Safe target**: HTTPS required (except localhost), optional host allowlist, redirects re-checked.
- **No blind overwrite**: approve/reject must send the task `revision` (or `status`) the agent saw; a stale value is rejected with a conflict error.
- **No secret leaks**: tokens and cookies are redacted from every response.
- **Clear errors**: 13 error kinds, always flagged with MCP `isError`.
- **Traceable**: every write emits an audit line with a `correlationId`.

## Quick start

Requires Node.js 22.6+ and a running Kaelix Dashboard with a service token.

Add to your MCP client config:

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

Restart the client and call `kaelix_server_info` first to check the setup.
Ready-made configs: [`examples/`](examples) (Claude Desktop, Cursor, Codex).

## Tools

| Tool                                                                            | What it does                                      | Changes data   |
| ------------------------------------------------------------------------------- | ------------------------------------------------- | -------------- |
| `kaelix_server_info`, `kaelix_capabilities`                                     | Show adapter config and detected features         | No             |
| `kaelix_list_agents`, `kaelix_list_tasks`, `kaelix_get_task`                    | Read agents and tasks                             | No             |
| `kaelix_create_task`, `kaelix_run_task`                                         | Create / run a task (`dryRun` available)          | Yes            |
| `kaelix_approve_task`, `kaelix_reject_task`                                     | Approve / reject (needs `expectedRevision`)       | Yes            |
| `kaelix_provider_health`                                                        | AI provider health                                | No             |
| `kaelix_local_ai_status`, `kaelix_local_ai_models`, `kaelix_local_ai_test_chat` | Local AI tools, only if the backend supports them | Test chat only |

Suggested agent flow: read with `kaelix_get_task`, then pass its `revision` to approve/reject.
Ask a human before running, approving or rejecting important tasks.

## Configuration

| Variable               | Default                     | Notes                                             |
| ---------------------- | --------------------------- | ------------------------------------------------- |
| `KAELIX_API_URL`       | `http://localhost:8000/api` | HTTPS required unless the host is loopback        |
| `KAELIX_API_TOKEN`     | unset                       | Bearer service token (recommended)                |
| `KAELIX_TIMEOUT_MS`    | `20000`                     | Integer between 1000 and 120000                   |
| `KAELIX_ALLOWED_HOSTS` | unset                       | Comma-separated host allowlist for non-local URLs |

Cookie auth exists for local development only (`KAELIX_ALLOW_COOKIE_AUTH=true` + `KAELIX_SESSION_COOKIE`).
Never commit real tokens or cookies.

## Good to know

- Write tools have real side effects. Treat the adapter like an automation client.
- Scoped tokens, atomic revision checks and the durable audit log are provided by the Kaelix
  Dashboard backend; the adapter uses them when the backend offers them.
- No server-side pagination and no adapter-side rate limiting yet (lists are capped at 200 items).
- Meant for a single trusted operator, not a multi-tenant setup. See [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm run build
npm test
```

See [CHANGELOG.md](CHANGELOG.md) for release notes. Licensed under [MIT](LICENSE).
