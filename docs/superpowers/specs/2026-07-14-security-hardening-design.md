# Security & Code-Quality Hardening Pass (#3) — Design

**Date:** 2026-07-14
**Backlog:** #3
**Status:** Approved (brainstorm complete)

## Goal

Harden the public, internet-exposed Rilo web surface. A read-only opus security
audit (2026-07-14) ranked the findings; this spec captures the fixes decided
issue-by-issue with the owner. It closes a **critical RCE** and a **high SSRF**,
removes plaintext-token exposure, adds rate limiting, makes de-allowlisting take
effect immediately on the web, and applies standard defense-in-depth headers /
handlers / redaction.

Audit context: the app is live behind Caddy TLS on a public box. Two adversaries
were modeled — an unauthenticated internet attacker and a malicious-but-allowlisted
(low-trust, self-registered + approved) user.

## Scope

Fixes for: **C1** (RCE), **H1** (SSRF), **M1** (Secure cookies), **M2** (rate
limiting), **M3** (web allowlist re-check), **L1–L4** (logout method, security
headers, error handler, log redaction). **L5** (npm audit: 4 low, no high/critical,
fix needs a breaking `ai@7` bump) — **no action**.

The audit's "Verified OK" set (SQLi all-parameterized, IDOR/ownership, magic-link
token strength + one-time-use, XSS escaping, encryption-at-rest, OAuth state/CSRF,
Telegram contact-spoof guard) needs no change.

## Decisions (from the issue-by-issue review)

1. **C1 + H1 — remove custom MCP entirely.** Keep only the vetted **Slack** preset
   and **Google** OAuth. Delete: the `custom-http` preset, the "Advanced: connect a
   custom MCP server manually" form, and the free-form `POST /mcp` route.
2. **M1 — always `secure: true`** on the session cookie and the OAuth-state cookie
   (browsers treat `http://localhost` as a secure context, so local dev is
   unaffected — no env gating needed).
3. **M2 — `@fastify/rate-limit`:** a global per-IP cap + tighter limits on the
   abuse-prone routes (`POST /register`, `POST /spaces/redeem`).
4. **M3 — re-check `isAllowlisted` in the web preHandler;** a de-allowlisted or
   deleted user's session is treated exactly like no session → redirect to `/login`.
5. **L1–L4 — fix all four** (owner: "fix the lows however you want").

## Current State (verified against HEAD)

- **C1:** `POST /mcp` (`src/web/routes/mcp.ts:171`) reads `transport/command/args/creds`
  from the request body (no owner gate) → `db/mcp.ts addMcpServer` (stored
  `enabled=1`) → on the next chat turn `mcp/manager.ts:20` spawns
  `new Experimental_StdioMCPTransport({ command, args, env: creds })`. Arbitrary
  host process = RCE for any allowlisted user.
- **H1:** same form + the `custom-http` preset (`mcp/presets.ts`, id `custom-http`)
  feed a user `url` + `creds` headers to `createMCPClient({ transport: { type, url,
  headers } })` (`manager.ts:29`) with no scheme/host validation → SSRF.
- **Presets:** `MCP_PRESETS` (`src/mcp/presets.ts`) holds `slack` (stdio,
  `command: npx`, `args: [-y, @modelcontextprotocol/server-slack]`, user supplies
  only tokens — fixed command, no RCE/SSRF) and `custom-http` (the SSRF vector).
  The one-click flow is `POST /mcp/preset` (`mcp.ts:146`).
- **M1:** `src/web/server.ts:75` `setCookie('token', …, { path, httpOnly, sameSite:
  'lax' })` — no `secure`. `src/web/routes/oauth.ts:71` state cookie — same.
- **M2:** no `@fastify/rate-limit` registered (`server.ts:54-56` registers cookie +
  formbody only). `POST /register` is in `PUBLIC_PATHS`.
- **M3:** `src/web/auth.ts` `sessionUserId` + the `server.ts:58-67` preHandler resolve
  the session user but never check `isAllowlisted`. The dispatch/scheduler paths do
  (`dispatch.ts:149`, `scheduler/fire.ts:16`, `heartbeat.ts:46`).
- **L1:** `GET /logout` (`server.ts:99`) clears the cookie.
- **L2:** no `@fastify/helmet`; HTML from `render.ts:42-50` uses an inline
  `<style>${CSS}</style>` (line 45) and a same-origin `<script src="/vendor/htmx.min.js">`
  (line 46) — CSP must allow `script-src 'self'` + `style-src 'self' 'unsafe-inline'`.
- **L3:** no `app.setErrorHandler`; uncaught throws return Fastify's default
  `{statusCode, message}` (internal message, no stack).
- **L4:** `src/log.ts:8-14` redact list omits `creds`/`*.creds`/`key`/`api_key`;
  some call sites log raw `err` objects.

## Architecture / Changes

### 1. Remove custom MCP (C1 + H1) — `mcp/presets.ts`, `web/routes/mcp.ts`

- **`src/mcp/presets.ts`:** delete the `custom-http` preset entry. `MCP_PRESETS`
  keeps `slack` only.
- **`src/web/routes/mcp.ts`:** delete the entire `POST /mcp` handler (the free-form
  custom-server route) and remove the "Advanced: connect a custom MCP server
  manually" `<details>`/form from `renderServicesBody`. Keep: the preset catalog
  render + `POST /mcp/preset`, the Google connect/disconnect routes, and the
  per-server toggle/delete routes (users may still disable/remove an existing
  server, including any custom one added before this change).
- **`src/mcp/manager.ts`:** unchanged — the stdio path still serves the Slack
  preset (fixed command). No user input reaches `command` any more.
- **Data note (guard):** removing the form stops *new* custom rows, but a custom
  `stdio`/`http`/`sse` row inserted **before** this change would still be assembled
  and executed. So `assembleMcpTools` (or `defaultMakeClient`) gains a guard: build
  an allowlist of `(transport, command|url-host)` tuples from the current
  `MCP_PRESETS`, and **skip any enabled server that doesn't match a preset**, logging
  the skip. This neutralizes any pre-existing malicious row without a DB migration,
  and future presets are covered automatically. (Prod has no known custom rows, but
  the guard is the correct belt-and-suspenders for the RCE.)

### 2. Secure cookies (M1) — `web/server.ts`, `web/routes/oauth.ts`

Add `secure: true` to both `setCookie` calls. `@fastify/cookie` `signed` behavior
and other flags unchanged.

### 3. Rate limiting (M2) — `web/server.ts` (+ dep)

- Add dependency `@fastify/rate-limit`.
- Register a **global** limit (e.g. `max: 100, timeWindow: '1 minute'` per IP) after
  cookie/formbody.
- Apply a **tighter** per-route limit via each route's `config.rateLimit` (e.g.
  `max: 5, timeWindow: '1 minute'`) on `POST /register` and `POST /spaces/redeem`.
- Keyed per-IP (default). Exact numbers are a knob — the plan sets concrete values;
  household traffic is far below them.

### 4. Web allowlist re-check (M3) — `web/auth.ts` / `web/server.ts`

In the preHandler, after resolving `userId` from the session, require
`isAllowlisted(db, userId)`; if false (or the user is gone), treat as unauthenticated
— redirect to `/login` (same as a missing/invalid session). Owner-only routes keep
their existing `requireOwner`/`isOwner` check.

### 5. Lows

- **L1 — logout POST:** change `GET /logout` to `POST /logout`; the nav "Log out"
  becomes a small inline POST form (mirrors the existing form-button pattern). Update
  `render.ts` nav.
- **L2 — helmet:** add `@fastify/helmet`; register with a CSP of roughly
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
  and HSTS enabled. **Verify htmx still works under this CSP** (it's same-origin and
  uses `hx-*` attributes, not inline `<script>`, so `script-src 'self'` should
  suffice — the plan includes a live check).
- **L3 — error handler:** `app.setErrorHandler((err, req, reply) => { log.error(...);
  reply.status(err.statusCode ?? 500).send(generic) })` — log the real error, return a
  generic message (preserve intentional 4xx status codes; never echo `err.message` for
  5xx).
- **L4 — redaction:** extend `src/log.ts` redact paths with `creds`, `*.creds`,
  `key`, `api_key` (and the `err.*` shapes that carry them); stop logging raw `err`
  objects from credentialed calls (log `err.message` / a summary instead).

## Error Handling

- Rate-limit rejections return `429` (plugin default) with a generic body — do not
  leak which route/limit triggered beyond the standard headers.
- The new error handler must preserve deliberate 4xx (e.g. redirects, not-found) and
  only genericize unexpected 5xx.

## Testing

- **C1/H1:** a test asserting `POST /mcp` no longer exists (404/405) and that
  `MCP_PRESETS` contains no `custom-http`; `assembleMcpTools` skips a stdio server
  whose command isn't preset-derived (guard test).
- **M1:** cookie-setting routes emit `Secure` (assert the `set-cookie` header on the
  `/login?token` verify response and the OAuth start response).
- **M2:** exceeding the per-route cap on `POST /register` / `POST /spaces/redeem`
  returns `429`; a normal request is unaffected. (Inject N+1 requests.)
- **M3:** a valid session for a **de-allowlisted** user is redirected to `/login`
  (not served); an allowlisted user still gets `200`.
- **L1:** `GET /logout` no longer clears the session (404/405); `POST /logout` does.
- **L2:** responses carry the CSP + HSTS headers; a live check that the web UI +
  htmx swaps still function under the CSP.
- **L3:** an induced handler throw returns a generic 500 without the internal message.
- **L4:** a log record built from an object containing `creds`/`api_key` shows them
  redacted.

## Files

- `src/mcp/presets.ts` — drop `custom-http`.
- `src/web/routes/mcp.ts` — remove `POST /mcp` + the Advanced form.
- `src/mcp/manager.ts` — skip non-preset stdio commands (guard).
- `src/web/server.ts` — `secure` cookie; register `@fastify/rate-limit` + `@fastify/helmet`; `setErrorHandler`; allowlist re-check in preHandler; `POST /logout`.
- `src/web/auth.ts` — allowlist-aware session resolution (or the check in the preHandler).
- `src/web/routes/oauth.ts` — `secure` state cookie.
- `src/web/routes/register.ts`, `src/web/routes/spaces.ts` — per-route `config.rateLimit`.
- `src/web/render.ts` — nav "Log out" → POST form.
- `src/log.ts` — extend redaction.
- `package.json` — add `@fastify/rate-limit`, `@fastify/helmet`.
- Tests across `tests/web/` + `tests/mcp/` for each fix above.

## Conflicts

Cross-cutting on `web/server.ts` (the audit's known hot file), but no other
workstream is in flight. Deploy after merge (same Caddy-overlay redeploy). The
CSP/helmet change is the one to smoke-test live (htmx under CSP, cert/HSTS).

## Non-goals / deferred

- L5 dependency bump (breaking `ai@7`).
- Broader CSRF tokens (SameSite=Lax + POST-only mutations is the accepted posture;
  L1 removes the last state-changing GET).
- The #14 de-allowlist reminder count-burn (separate backlog follow-up; related to
  M3 but in the scheduler path, out of this web-focused pass).
