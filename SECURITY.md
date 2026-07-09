# Security Policy

Kaelix MCP Adapter can trigger actions in a self-hosted Kaelix Dashboard through
MCP tools. Treat its credentials like production secrets.

## Supported Security Model

- Prefer `KAELIX_API_TOKEN` service-token auth.
- Keep browser cookie auth for local development only.
- Do not use `KAELIX_SESSION_COOKIE` on shared machines, remote MCP servers, CI,
  synced config folders, or public examples.
- Do not commit `.env`, tokens, cookies, logs with headers, or dashboard
  databases.

## Reporting Issues

Open a GitHub issue for non-sensitive bugs.

For sensitive reports, do not paste secrets or exploit details into a public
issue. Use GitHub private vulnerability reporting if enabled, or contact the
maintainer privately first.

## Recommended Backend Guardrails

- Issue scoped MCP tokens such as `tasks:read`, `tasks:create`, `tasks:run`,
  `tasks:approve`, `providers:read`, and `local-ai:test`.
- Log every MCP-triggered write action in the dashboard backend.
- Require human review in the dashboard for dangerous task outputs.
- Keep token rotation and revocation available from the dashboard.
