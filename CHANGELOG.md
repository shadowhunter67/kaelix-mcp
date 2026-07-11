# Changelog

All notable changes to Kaelix MCP Adapter will be documented here.

## 0.3.0

### Breaking

- `kaelix_approve_task`/`kaelix_reject_task` now require **at least one** of
  `expectedStatus` or `expectedRevision` (previously `expectedStatus` alone
  was required and sufficient). Omitting both now fails with a `validation`
  error before any backend call is made, instead of a TypeScript-level
  required-field error at the call site.

### Added

- `expectedRevision` (preferred): forwarded to the backend as
  `?expected_revision=` on approve/reject, checked atomically in the same DB
  transaction as the write (requires a backend that returns `revision` on
  tasks — see the paired Kaelix Dashboard backend changes). A stale value
  fails with a real backend `409`, mapped to the adapter's `conflict` error
  kind with `isError: true`, same as before. When `expectedRevision` is
  supplied, the adapter skips its own read-then-write `expectedStatus`
  pre-check (redundant once the backend enforces it atomically).
- `expectedStatus` remains supported as a fallback for backends that don't
  send `revision` yet — documented as non-atomic (TOCTOU), not a replacement
  for `expectedRevision` where available.
- `taskSchema`/`taskWithLogsSchema` now validate a `revision` field (defaults
  to `0` if the backend doesn't send one, so older backends don't fail
  validation).
- 6 new tests: atomic revision path skips the pre-read, backend 409 maps to
  `conflict`, both fields supplied together (revision wins), and validation
  errors when neither confirmation field is supplied on either tool.
- 3 more tests for backend rate limiting: a GET retried once on `429` honors
  `Retry-After` (a `0` value adds no artificial delay), gives up after the
  existing 2-attempt cap on a persistent `429` (surfacing `rate_limit`), and
  a write request is never retried on `429` even though it's retryable for
  reads. No adapter behavior changed here — `classifyStatus`/retry logic
  already handled this in 0.2.0; these tests make it explicit instead of
  only covering it indirectly via 503. 76 → 85 tests total.

## 0.2.0

Security/production-readiness hardening pass. **Breaking changes** are
flagged below; this is a 0.x release so they ship as a minor bump.

### Breaking

- Tool responses are now wrapped in an envelope: success is
  `{ ok: true, correlationId, data }` instead of the raw backend JSON, and
  every MCP failure sets `isError: true` on the tool result (previous
  versions returned `{ ok:false, error }` as plain text with no `isError`
  flag, which some clients could mistake for a success).
- `kaelix_approve_task` and `kaelix_reject_task` now require an
  `expectedStatus` argument (read the task first via `kaelix_get_task`). The
  adapter re-checks live status immediately before mutating and returns a
  `conflict` error on mismatch.
- `KAELIX_API_URL` (and any redirect target) must now be `https://` unless
  the host is loopback (`localhost`/`127.0.0.0/8`/`::1`); embedded
  `user:pass@` credentials in the URL are now rejected at startup.
- `KAELIX_TIMEOUT_MS` is now parsed strictly: only a bare integer in
  `[1000, 120000]` is accepted (previously `Number(...)` silently coerced
  invalid input to `NaN`/`0`).
- `KAELIX_ALLOW_COOKIE_AUTH=true` now requires `KAELIX_SESSION_COOKIE` to
  also be set, or the adapter fails at startup instead of silently running
  with cookie auth "on" but no cookie.
- When both a bearer token and a cookie are configured, the cookie is now
  never attached to any request (previously both headers could be sent on
  the same request).

### Added

- SSRF/redirect hardening: only one redirect hop is followed, the target is
  re-validated against the same URL rules as `KAELIX_API_URL`, and
  `Authorization`/`Cookie` are stripped on any cross-origin redirect. New
  `KAELIX_ALLOWED_HOSTS` allowlist for non-loopback targets.
- Expanded error taxonomy (`forbidden`, `conflict`, `rate_limit`,
  `response_too_large`, `capability_unavailable` added alongside the
  existing kinds) with accurate HTTP-status classification (401→auth,
  403→forbidden, 404→not_found, 409→conflict, 429→rate_limit).
- Bounded retry (2 attempts total) for idempotent `GET`/`HEAD` requests on
  network errors or 5xx/429, honoring `Retry-After`; write requests are
  never auto-retried by the transport.
- Response schema validation (Zod) for every endpoint, a 2 MiB response size
  cap, and client-side list truncation (`kaelix_list_agents`/
  `kaelix_list_tasks` cap at 200 items and report
  `{ truncated, originalSize, returnedSize }`).
- Secret redaction applied to every tool response (success and error) and to
  backend error detail text, in addition to the existing "secrets are never
  returned" contract for `kaelix_server_info`.
- Capability discovery: `kaelix_local_ai_*` tools are only registered after
  a startup probe confirms the backend exposes `/local-ai/*` (or
  `KAELIX_ENABLE_LOCAL_AI_TOOLS=on` forces it). New `kaelix_capabilities`
  tool reports the detected state.
- Adapter-side write audit line (`kaelix_mcp_audit`, secret-free JSON) to
  stderr for every task write, tagged with a per-call correlation ID.
- ESLint (typescript-eslint, type-aware) with a `lint` script, wired into
  both CI and the release/prepublish gate.
- CI now runs on a Node 22.x/24.x matrix and adds `lint`,
  `npm audit --omit=dev`, and `npm pack --dry-run` as required (non-skippable)
  gate steps; the release workflow mirrors the same gates before publishing.
- `examples/codex.toml` for Codex CLI's TOML-based MCP config.
- New README sections: environment variable reference table, Security Model
  & Trust Boundaries, Response Validation/Pagination/Redaction, Capability
  Discovery, and Known Limitations (documents the backend gaps — no scoped
  tokens, no atomic concurrency, no MCP audit log, no server-side pagination
  — that this adapter cannot close on its own).
- 60 new unit tests (16 → 76) covering URL/SSRF validation, timeout schema
  parsing, cookie/bearer precedence, redirect credential stripping, retry
  behavior, oversized-response handling, response schema validation,
  truncation, redaction, capability discovery, and the `expectedStatus`
  confirmation boundary.

### Known limitations (tracked as backend blockers, not fixed here)

- No scoped/expiring/revocable MCP tokens — the backend still checks one
  `KAELIX_MCP_TOKEN` value with a single implicit identity.
- No backend-enforced atomic optimistic concurrency (revision/ETag + 409) —
  the adapter's `expectedStatus` check is best-effort and non-atomic.
- No durable, queryable backend audit log for MCP-triggered writes.
- No server-side pagination on `GET /agents`/`GET /tasks`.

See README "Known Limitations" for the specific backend files each item
would touch.

## 0.1.1

- Improved README for users, MCP clients, and AI agents.
- Added clearer quick start, tool contract, backend API contract, and troubleshooting notes.
- Updated Cursor example config to use `npx -y kaelix-mcp`.

## 0.1.0

- Initial MCP adapter scaffold.
- Added tools for agents, tasks, provider health, and local AI endpoints.
- Added README screenshots and project status notes.
