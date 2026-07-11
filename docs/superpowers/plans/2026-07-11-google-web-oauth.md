# Google Web OAuth (opt-in) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in public Google OAuth authorization-code flow gated by `ENABLE_WEB_OAUTH`, keeping the existing loopback/paste flow as the default firewalled fallback (flag off = zero behavior change).

**Architecture:** New provider-generic route module `src/web/routes/oauth.ts` exposes `GET /oauth/google/start` (authenticated owner initiates) and `GET /oauth/google/callback` (public path, inert unless flag on). CSRF `state` + initiating `userId` are carried in one signed, httpOnly, sameSite=lax, 10-min cookie. Both the new flow and the kept paste flow store the refresh token via the unchanged `db/oauth.ts`.

**Tech Stack:** Fastify 5, `@fastify/cookie` 10 (signed cookies), `google-auth-library` 10 (`OAuth2Client`), TypeScript (ESM, `.js` import specifiers), vitest.

## Global Constraints

- `ENABLE_WEB_OAUTH` default **false**. Flag off ⇒ zero behavior change; callback inert.
- Google only. Slack stays paste. Routes provider-generic (`/oauth/:provider/...`) but only `google` implemented.
- `state` cookie MUST be: signed, `httpOnly`, `sameSite: 'lax'`, short TTL (10 min).
- Callback MUST reject missing/mismatched state and MUST NOT write when flag is off.
- No stack traces / raw errors to the client — generic flash only.
- Reuse `GOOGLE_SCOPES` from `src/agent/google/client.ts` and `setOAuthToken` from `src/db/oauth.ts` unchanged.
- ESM: all local imports end in `.js`. Touch ONLY files in the spec's "Files touched".

---

### Task 1: Config flag + cookie signing secret

**Files:**
- Modify: `src/config.ts` — add `enableWebOauth: boolean`
- Modify: `.env.example` — add `ENABLE_WEB_OAUTH`
- Modify: `src/web/server.ts` — register cookie with a signing secret, widen `WebDeps.appCfg` pick
- Test: `tests/config.test.ts` (if exists) — otherwise assert via oauth route tests

**Interfaces:**
- Produces: `AppConfig.enableWebOauth: boolean`. `WebDeps.appCfg` picks `enableWebOauth | webBaseUrl | encKey | googleClientId | googleClientSecret | openrouterKeyFallback`.
- Cookie signing secret = `appCfg.encKey` (base64 32-byte key already required at boot).

- [ ] Add `enableWebOauth: boolean` to `AppConfig`, load as `env.ENABLE_WEB_OAUTH === 'true'`.
- [ ] Add `ENABLE_WEB_OAUTH=` line to `.env.example` with a comment on required public HTTPS `WEB_BASE_URL` + Web-application OAuth client redirect.
- [ ] In `server.ts`, register `cookie` with `{ secret: deps.appCfg.encKey }` and widen the `WebDeps.appCfg` Pick.

### Task 2: OAuth routes module (TDD)

**Files:**
- Create: `src/web/routes/oauth.ts`
- Modify: `src/web/server.ts` — add callback to `PUBLIC_PATHS`, register routes
- Test: `tests/web/oauth-route.test.ts`

**Interfaces:**
- Produces: `registerOauthRoutes(app, db, opts: { enableWebOauth, webBaseUrl, googleClientId?, googleClientSecret?, makeClient?: (cfg) => OAuth2Client })`. `makeClient` is an injectable factory so tests can stub `getToken`.
- Consumes: `GOOGLE_SCOPES`, `setOAuthToken`, signed cookie API `reply.setCookie`/`req.unsignCookie`.

Tests (write first, watch fail, implement, watch pass):
- [ ] `start` flag on, authenticated → 302 to `accounts.google.com` URL containing `state=`, encoded `redirect_uri=.../oauth/google/callback`, and scopes; sets signed `oauth_state` cookie (`httpOnly`, `SameSite=Lax`, `Max-Age` ~600).
- [ ] `start` flag off → inert (redirect to `/mcp`), no cookie set.
- [ ] `callback` flag off → inert redirect to `/mcp`, no token stored.
- [ ] `callback` matching state + fake `getToken` returning `{ refresh_token }` → `setOAuthToken(db, userId, 'google', rt)`, redirect `/mcp?saved=google`, cookie cleared.
- [ ] `callback` missing cookie → redirect `/mcp?error=...`, no token stored.
- [ ] `callback` mismatched state → redirect `/mcp?error=...`, no token stored.
- [ ] `callback` token exchange throws → generic error flash redirect, no stack trace, no token stored.
- [ ] `callback` no refresh_token in tokens → error flash (revoke+retry guidance), no store.

### Task 3: MCP card branch (TDD)

**Files:**
- Modify: `src/web/routes/mcp.ts` — thread `enableWebOauth` into opts, branch `renderGoogleConnect`
- Modify: `src/web/server.ts` — pass `enableWebOauth` into `registerMcpRoutes` opts + register oauth routes
- Test: `tests/web/mcp-route.test.ts` — add flag-on/flag-off render assertions

- [ ] Flag on → card shows "Connect with Google" link to `/oauth/google/start`, no paste form.
- [ ] Flag off → paste form present (unchanged current behavior).

### Task 4: Docs + fallback comment

**Files:**
- Modify: `deploy/README.md` — note public OAuth needs HTTPS reverse proxy + registered redirect (docs only)
- Modify: `scripts/google-auth.ts` — one-line comment that it is the fallback when `ENABLE_WEB_OAUTH` is off

### Task 5: Verify + review

- [ ] `npm test` green, `npm run typecheck` clean.
- [ ] `superpowers:requesting-code-review` on the diff; address findings.
- [ ] Commit to `feat/1-google-web-oauth`.
