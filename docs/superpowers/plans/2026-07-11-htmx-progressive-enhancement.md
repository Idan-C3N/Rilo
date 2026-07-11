# htmx Progressive Enhancement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Services actions (enable/disable/delete, Google connect/disconnect) update inline without a full-page reload, using vendored htmx — no build step, deploy unchanged, JS-off still works.

**Architecture:** Vendor htmx (committed, served by the app, loaded via one `<script>`). Extract the Services page body into `renderServicesBody()` wrapped in `<div id="services">`. Enhanced forms carry `hx-post hx-target="#services" hx-swap="outerHTML"`; their routes return `renderServicesBody()` for `HX-Request` requests and the existing redirect otherwise. One region swap per action — simpler and more robust than per-row/out-of-band swaps, identical UX.

**Tech Stack:** Node 22 / TypeScript / ESM (`.js` imports), Fastify (server-rendered HTML), htmx 2.x (vendored), vitest (`app.inject`).

## Global Constraints

- **No build step / no bundler / no CDN.** htmx is a committed static file served by the app.
- **Progressive enhancement:** enhanced routes return an HTML partial when `req.headers['hx-request'] === 'true'`, else the current `redirect(...)`. Non-JS clients keep working.
- **Scope:** only Services enable/disable/delete + Google connect/disconnect are enhanced. Add-server forms (preset/custom/manual) and model/key/login forms stay plain.
- **Deviation from spec (deliberate):** the spec described per-row (`#mcp-row-<id>`) swaps + a `#google-card`. This plan uses a single `#services` region swap instead — same no-reload UX, avoids two-section Google out-of-band complexity. Documented here as the governing approach.
- ESM `.js` imports; all dynamic values through `esc()`. Keep suite + `npx tsc --noEmit` green before each commit.

---

### Task 1: Vendor, serve, and load htmx

Commit the htmx file, serve it from a public route, and load it site-wide via `layout()`.

**Files:**
- Create: `src/web/vendor/htmx.min.js` (downloaded, committed)
- Modify: `src/web/server.ts` (read the file at startup; `GET /vendor/htmx.min.js`; add to `PUBLIC_PATHS`)
- Modify: `src/web/render.ts` (add the `<script>` tag in `layout()`'s `<head>`)
- Test: `tests/web/htmx-asset.test.ts` (create)

**Interfaces:**
- Produces: `GET /vendor/htmx.min.js` (public, cached) serving the htmx source; every page loads `<script src="/vendor/htmx.min.js" defer>`.

- [ ] **Step 1: Download and commit the htmx file**

```bash
mkdir -p src/web/vendor
curl -fsSL -o src/web/vendor/htmx.min.js https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js
# sanity: non-empty and looks like htmx
test -s src/web/vendor/htmx.min.js && grep -q "htmx" src/web/vendor/htmx.min.js && echo OK
```
Expected: `OK` (file exists, ~48KB, contains "htmx").

- [ ] **Step 2: Write the failing test** — `tests/web/htmx-asset.test.ts`

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { buildWebApp } from '../../src/web/server.js';
import { layout } from '../../src/web/render.js';

let db: DB, app: any;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
  db = openDb(':memory:');
  app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => [] });
});

describe('htmx asset', () => {
  it('serves the vendored htmx script without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/vendor/htmx.min.js' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('javascript');
    expect(res.body.length).toBeGreaterThan(1000);
    expect(res.body).toContain('htmx');
  });

  it('layout loads the htmx script tag', () => {
    expect(layout('X', '')).toContain('<script src="/vendor/htmx.min.js" defer></script>');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/web/htmx-asset.test.ts`
Expected: FAIL — route 404 / redirect; layout lacks the script tag.

- [ ] **Step 4: Serve htmx in `src/web/server.ts`**

Add imports at the top:
```ts
import { readFileSync } from 'node:fs';
```
Add a module-level constant (after the imports, before `PUBLIC_PATHS`):
```ts
// Vendored htmx, read once at startup and served from memory (no build step).
const HTMX_JS = readFileSync(new URL('./vendor/htmx.min.js', import.meta.url), 'utf8');
```
Add the path to `PUBLIC_PATHS`:
```ts
const PUBLIC_PATHS = new Set(['/login', '/vendor/htmx.min.js']);
```
Register the route (inside `buildWebApp`, alongside the other routes, before `registerModelsRoutes`):
```ts
  app.get('/vendor/htmx.min.js', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.type('application/javascript').send(HTMX_JS);
  });
```

- [ ] **Step 5: Load it in `src/web/render.ts`**

In `layout()`, add the script tag next to the inline `<style>` in `<head>`. Change:
```ts
  <style>${CSS}</style></head>
```
to:
```ts
  <style>${CSS}</style>
  <script src="/vendor/htmx.min.js" defer></script></head>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/web/htmx-asset.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 7: Full suite**

Run: `npm test`
Expected: PASS (the new `<script>` tag doesn't affect existing assertions; every prior render test still holds).

- [ ] **Step 8: Commit**

```bash
git add src/web/vendor/htmx.min.js src/web/server.ts src/web/render.ts tests/web/htmx-asset.test.ts
git commit -m "feat(ui): vendor + serve + load htmx (no build, no CDN)"
```

---

### Task 2: `#services` region swap + HX-aware Services routes

Extract the Services body into `renderServicesBody()`, add `hx-*` to the enhanced forms, and make the four mutating routes return the region on `HX-Request` (redirect otherwise).

**Files:**
- Modify: `src/web/routes/mcp.ts`
- Test: extend `tests/web/mcp-route.test.ts`

**Interfaces:**
- Consumes: `layout`/`esc` (render), `listMcpServers`/`setMcpEnabled`/`deleteMcpServer`/`addMcpServer` (db/mcp), `renderGoogleConnected`/`renderGoogleConnect`/`renderPresets` (existing in file).
- Produces: `renderServicesBody(db, userId, opts): string` wrapped in `<div id="services">`.

- [ ] **Step 1: Write the failing tests** — append to `tests/web/mcp-route.test.ts`

```ts
describe('htmx region swap', () => {
  it('plain toggle still redirects (no-JS fallback)', async () => {
    const { addMcpServer } = await import('../../src/db/mcp.js');
    addMcpServer(db, uid, { name: 'S', transport: 'stdio', command: 'x', args: [] });
    const id = (await import('../../src/db/mcp.js')).listMcpServers(db, uid)[0]!.id;
    const res = await app.inject({ method: 'POST', url: `/mcp/${id}/toggle`, headers: { cookie } });
    expect(res.statusCode).toBe(302);
  });

  it('htmx toggle returns the #services region with the flipped state', async () => {
    const { addMcpServer, listMcpServers } = await import('../../src/db/mcp.js');
    addMcpServer(db, uid, { name: 'S', transport: 'stdio', command: 'x', args: [] });
    const id = listMcpServers(db, uid)[0]!.id;
    const res = await app.inject({
      method: 'POST', url: `/mcp/${id}/toggle`,
      headers: { cookie, 'hx-request': 'true' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="services">');
    expect(res.body).toContain('Disable'); // was disabled by default → now enabled → shows "Disable"
  });

  it('htmx delete returns the region without the deleted service', async () => {
    const { addMcpServer, listMcpServers } = await import('../../src/db/mcp.js');
    addMcpServer(db, uid, { name: 'ZapService', transport: 'stdio', command: 'x', args: [] });
    const id = listMcpServers(db, uid)[0]!.id;
    const res = await app.inject({
      method: 'POST', url: `/mcp/${id}/delete`,
      headers: { cookie, 'hx-request': 'true' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="services">');
    expect(res.body).not.toContain('ZapService');
  });

  it('htmx google connect returns the region showing the connected card', async () => {
    const gApp = await buildWebApp({
      db, getModels: async () => [],
      appCfg: { googleClientId: 'x', googleClientSecret: 'y' } as any,
    });
    const res = await gApp.inject({
      method: 'POST', url: '/google/connect',
      headers: { cookie, 'hx-request': 'true' },
      payload: { refresh_token: '1//abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="services">');
    expect(res.body).toContain('Disconnect');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/web/mcp-route.test.ts`
Expected: FAIL — htmx requests currently 302 (no partial); no `#services` wrapper.

- [ ] **Step 3: Add `hx-*` to the Google helper forms in `src/web/routes/mcp.ts`**

`renderGoogleConnected` — the disconnect form:
```ts
    <form method="post" action="/google/disconnect" hx-post="/google/disconnect" hx-target="#services" hx-swap="outerHTML"><button class="btn-secondary">Disconnect</button></form></div>`;
```
`renderGoogleConnect` — the connect form opening tag:
```ts
    <form method="post" action="/google/connect" hx-post="/google/connect" hx-target="#services" hx-swap="outerHTML">
```

- [ ] **Step 4: Extract `renderServicesBody()` and rewrite the `GET /mcp` handler**

Add this helper (after `SAVED_FLASH`, before `parseCreds`):
```ts
function renderServicesBody(db: DB, userId: number, opts: { googleEnabled: boolean }): string {
  const servers = listMcpServers(db, userId);
  const googleConnected = renderGoogleConnected(db, userId, opts.googleEnabled);
  const googleConnect = renderGoogleConnect(db, userId, opts.googleEnabled);
  const rows = servers
    .map(
      (s) => `<div class="card"><b>${esc(s.name)}</b> (${esc(s.transport)}) ${s.enabled ? '🟢' : '⚪️'}
      <div class="muted">${esc(s.url ?? s.command ?? '')}</div>
      <form method="post" action="/mcp/${s.id}/toggle" class="inline-form" hx-post="/mcp/${s.id}/toggle" hx-target="#services" hx-swap="outerHTML"><button class="btn-secondary">${s.enabled ? 'Disable' : 'Enable'}</button></form>
      <form method="post" action="/mcp/${s.id}/delete" class="inline-form" hx-post="/mcp/${s.id}/delete" hx-target="#services" hx-swap="outerHTML" hx-confirm="Remove this service?"><button class="btn-danger">Delete</button></form>
      </div>`,
    )
    .join('');
  return `<div id="services">${BUILTIN_SECTION}
        <h2>Your services</h2>
        ${googleConnected}${rows}
        ${!googleConnected && !rows ? '<div class="empty">No services connected yet. Connect one below.</div>' : ''}
        <h2>Connect a service</h2>
        ${googleConnect}
        ${renderPresets()}
        <details><summary>Advanced: connect a custom MCP server manually</summary>
        <div class="card"><h3>Add server</h3>
        <form method="post" action="/mcp">
          <label>Name<input name="name" required></label>
          <label>Transport
            <select name="transport"><option value="stdio">stdio</option><option value="http">http</option><option value="sse">sse</option></select>
          </label>
          <label>Command (stdio)<input name="command" placeholder="node"></label>
          <label>Args (space-separated)<input name="args" placeholder="server.js --flag"></label>
          <label>URL (http/sse)<input name="url" placeholder="https://host/mcp"></label>
          <label>Creds (KEY=VALUE per line)<textarea name="creds" rows="3"></textarea></label>
          <button type="submit">Add</button>
        </form></div></details></div>`;
}
```
Replace the `GET /mcp` handler body (the part that builds `rows`/`googleConnected`/`googleConnect` and calls `layout`) with:
```ts
  app.get<{ Querystring: { saved?: string } }>('/mcp', async (req, reply) => {
    const userId = (req as any).userId as number;
    const flash = req.query.saved ? SAVED_FLASH[req.query.saved] : undefined;
    reply.type('text/html').send(
      layout('Services', renderServicesBody(db, userId, opts), { active: 'services', flash }),
    );
  });
```

- [ ] **Step 5: Make the four mutating routes HX-aware**

Add a helper at the top of `registerMcpRoutes` (or inline the check). For each of the four routes, after performing the mutation, return the region on htmx requests, else keep the existing redirect. Rewrite them:
```ts
  const hx = (req: { headers: Record<string, unknown> }) => req.headers['hx-request'] === 'true';

  app.post<{ Params: { id: string } }>('/mcp/:id/toggle', async (req, reply) => {
    const userId = (req as any).userId as number;
    const server = listMcpServers(db, userId).find((s) => s.id === Number(req.params.id));
    if (server) setMcpEnabled(db, server.id, !server.enabled);
    if (hx(req)) { reply.type('text/html').send(renderServicesBody(db, userId, opts)); return; }
    reply.redirect('/mcp');
  });

  app.post<{ Params: { id: string } }>('/mcp/:id/delete', async (req, reply) => {
    const userId = (req as any).userId as number;
    const server = listMcpServers(db, userId).find((s) => s.id === Number(req.params.id));
    if (server) deleteMcpServer(db, server.id);
    if (hx(req)) { reply.type('text/html').send(renderServicesBody(db, userId, opts)); return; }
    reply.redirect('/mcp?saved=deleted');
  });

  app.post<{ Body: { refresh_token?: string } }>('/google/connect', async (req, reply) => {
    const userId = (req as any).userId as number;
    const rt = (req.body.refresh_token ?? '').trim();
    if (rt) setOAuthToken(db, userId, 'google', rt);
    if (hx(req)) { reply.type('text/html').send(renderServicesBody(db, userId, opts)); return; }
    reply.redirect('/mcp?saved=google');
  });

  app.post('/google/disconnect', async (req, reply) => {
    const userId = (req as any).userId as number;
    deleteOAuthToken(db, userId, 'google');
    if (hx(req)) { reply.type('text/html').send(renderServicesBody(db, userId, opts)); return; }
    reply.redirect('/mcp');
  });
```
Leave `/mcp/preset` and `/mcp` (custom add) as-is (plain redirect — out of scope).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/web/mcp-route.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean. (The `hx` helper's param type matches Fastify's `req.headers`; if tsc complains, type it as `(req: any) => req.headers['hx-request'] === 'true'`.)

- [ ] **Step 7: Full suite**

Run: `npm test`
Expected: PASS — existing preset/toggle/delete tests still pass (plain requests still redirect).

- [ ] **Step 8: Commit**

```bash
git add src/web/routes/mcp.ts tests/web/mcp-route.test.ts
git commit -m "feat(ui): htmx region swap for Services toggle/delete + Google connect/disconnect"
```

---

## Self-review notes (author)

- **Spec coverage:** vendored htmx served + loaded (T1) ✓; progressive enhancement HX→partial else redirect (T2) ✓; Services enable/disable/delete inline (T2) ✓; Google connect/disconnect inline (T2) ✓; JS-off fallback preserved (plain redirect kept + tested) ✓; tests for both paths + vendor route + layout tag ✓.
- **Deliberate deviation:** single `#services` region swap instead of per-row `#mcp-row-<id>` + `#google-card` OOB — noted in Global Constraints; same UX, less complexity. Flagged to the human at handoff.
- **No placeholders:** complete code in every step; `renderServicesBody` is the current GET body verbatim + `hx-*` attrs + `#services` wrapper.
- **Type consistency:** `renderServicesBody(db, userId, opts)` signature identical at definition and all call sites (GET + 4 routes); `opts` is the closure param of `registerMcpRoutes`.
- **Scope:** add-server (preset/custom) and model/key/login forms intentionally NOT enhanced.

## Manual check (after both tasks)

App in watch mode on :8080 (logged in): on Services, Enable/Disable and Delete update the list with no full-page reload; Delete asks to confirm; connecting/disconnecting Google swaps the cards inline. Disable JS → same actions still work via redirects.
