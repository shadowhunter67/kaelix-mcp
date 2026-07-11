# Security Policy

Kaelix MCP Adapter can trigger actions in a self-hosted Kaelix Dashboard through
MCP tools. Treat its credentials like production secrets.

## Supported Security Model

- Prefer `KAELIX_API_TOKEN` service-token auth. When both a token and a
  cookie are configured, the adapter always uses the token and never sends
  the cookie, on every request including same-origin redirects.
- Keep browser cookie auth for local development only.
- `KAELIX_SESSION_COOKIE` is ignored unless `KAELIX_ALLOW_COOKIE_AUTH=true` is
  also set; setting only one of the two fails startup with a configuration
  error rather than silently ignoring the cookie.
- `KAELIX_API_URL` (and any redirect target) must be HTTPS unless the host is
  loopback (`localhost`, `127.0.0.0/8`, `::1`); embedded `user:pass@`
  credentials in the URL are rejected. Use `KAELIX_ALLOWED_HOSTS` to further
  restrict non-loopback targets to an explicit allowlist.
- `Authorization`/`Cookie` headers are stripped on any redirect that crosses
  origin, and only one redirect hop is followed.
- `KAELIX_TIMEOUT_MS` only accepts a bare integer in `[1000, 120000]` — no
  string coercion of unexpected input.
- Response bodies over 2 MiB are rejected rather than buffered; response
  shapes are schema-validated before use; secret-shaped strings are redacted
  from every tool output (defense in depth, not a substitute for not logging
  secrets in the first place).
- Do not use `KAELIX_SESSION_COOKIE` on shared machines, remote MCP servers, CI,
  synced config folders, or public examples.
- Do not commit `.env`, tokens, cookies, logs with headers, or dashboard
  databases.
- Treat production readiness as a backend responsibility: enforce scoped tokens,
  audit MCP-triggered write actions, rate limit per token/tool, and keep token
  rotation/revocation available. **As of this adapter version, the reference
  Kaelix Dashboard backend does not yet implement scoped tokens, atomic
  optimistic concurrency, or a durable MCP audit log** — see the README
  "Known Limitations" section before deploying against a semi-trusted client.

## Safe Deployment Configurations

- **Recommended:** `KAELIX_API_URL=https://your-dashboard.example.com/api`
  with `KAELIX_API_TOKEN` set, run by the same operator who controls both the
  MCP client and the dashboard.
- **Local development only:** `KAELIX_API_URL=http://localhost:8000/api`
  with either `KAELIX_API_TOKEN` or (if the backend has no token configured
  yet) `KAELIX_ALLOW_COOKIE_AUTH=true` + `KAELIX_SESSION_COOKIE`.
- **Do not**: point `KAELIX_API_URL` at a shared/multi-tenant dashboard while
  relying on cookie auth, run the adapter with a token that is also used by
  other non-MCP clients (so approve/reject audit trails stay attributable),
  or commit `examples/*.json`/`.env` files with real values filled in.

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
