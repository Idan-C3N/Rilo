# htmx Progressive Enhancement — Design

**Date:** 2026-07-11
**Workstream:** #10 of the open-source initiative (web-UI interactivity).
**Status:** Approved design, ready for plan.

## Goal

Make the highest-friction web-UI interactions snappy (inline updates, no full-page
reloads) using **htmx**, while keeping the project's clone-and-run ethos: **no build
step, deploy unchanged, no CDN**. htmx is vendored (committed) and served by the app.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Library | **htmx 2.x**, vendored (committed `src/web/vendor/htmx.min.js`), served by the app — no CDN, no bundler |
| Scope | High-value spots only: **Services** enable/disable/delete + Google connect/disconnect. Simple forms (model save, key save) stay as-is |
| Enhancement model | **Progressive** — works without JS. Routes return a partial for `HX-Request` requests, else the existing redirect |
| Delivery | one `<script src="/vendor/htmx.min.js">` in `layout()`; the vendor path is public + long-cached |

## Non-goals

- No build step, bundler, or CDN.
- No SPA / client router / client state.
- No change to model-save / key-save / login flows (they stay plain server-rendered).
- No change to agent, scheduler, db, auth.

## Why this is UX, not a rewrite

The server keeps rendering HTML. htmx only intercepts specific forms and swaps in a
server-rendered fragment. Non-htmx clients (JS off, crawlers) get the identical old
behavior via the redirect fallback, so nothing regresses.

## 1. htmx delivery

- **Vendor:** commit `src/web/vendor/htmx.min.js` (htmx 2.x minified, ~48KB). It is a
  static asset in the repo — "no build" means no compile pipeline, not "no committed
  dependency file."
- **Serve:** `GET /vendor/htmx.min.js` returns the file with
  `Content-Type: application/javascript` and `Cache-Control: public, max-age=31536000, immutable`.
  Add the path to `PUBLIC_PATHS` so it loads even on the (bare) login page without an
  auth redirect. Read the file once at startup (module load) and serve from memory.
- **Load:** `layout()` adds `<script src="/vendor/htmx.min.js"></script>` in `<head>`.
  Global; harmless on pages with no htmx attributes.

## 2. Progressive-enhancement pattern

A single convention across enhanced routes:

```
const isHx = req.headers['hx-request'] === 'true';
// ... perform the mutation ...
if (isHx) { reply.type('text/html').send(<partial>); return; }
reply.redirect('/mcp?saved=…');   // unchanged non-JS behavior
```

- **htmx request** → 200 + the swapped HTML fragment.
- **plain request** → today's redirect (kept verbatim), so JS-off still works.

## 3. Enhanced interactions (`src/web/routes/mcp.ts`)

### Row helper
Extract `renderMcpRow(server): string` — the single-server card, wrapped with a stable
id: `<div id="mcp-row-${server.id}" class="card">…</div>`. Reused by (a) the `/mcp`
list rendering and (b) the toggle partial response, so the markup lives in one place.

### Enable / Disable — `POST /mcp/:id/toggle`
- Row form: `hx-post="/mcp/:id/toggle" hx-target="#mcp-row-${id}" hx-swap="outerHTML"`.
- Route: flip `enabled` (as today); if `isHx` → return `renderMcpRow(updated)`; else redirect `/mcp`.
- Result: the row re-renders in place with the new state + button label.

### Delete — `POST /mcp/:id/delete`
- Row form: `hx-post="/mcp/:id/delete" hx-target="#mcp-row-${id}" hx-swap="outerHTML" hx-confirm="Remove this service?"`.
- Route: delete (as today); if `isHx` → return `''` (empty body → row is removed); else redirect `/mcp?saved=deleted`.

### Google connect / disconnect — `POST /google/connect`, `POST /google/disconnect`
- Wrap the Google area in `<div id="google-card">…</div>` (the connect *or* connected
  card, whichever applies).
- Forms: `hx-post hx-target="#google-card" hx-swap="outerHTML"`.
- Routes: perform the token set/delete (as today); if `isHx` → return the *other*
  variant (`renderGoogleConnected(...)` after connect, `renderGoogleConnect(...)` after
  disconnect), each wrapped in `<div id="google-card">`; else redirect `/mcp`.
- The existing `renderGoogleConnected` / `renderGoogleConnect` helpers are reused; they
  gain the `#google-card` wrapper (or a thin wrapper is added at call sites + partials).

### Add-server forms (preset / custom / manual)
Out of scope — they add a *new* row and are less frequent; they keep the plain
redirect. (Can be revisited if desired; not in this workstream.)

## 4. Error handling

- Unknown/blocked mutation (e.g. server id not found): keep current behavior — the
  action is a no-op and, for htmx, return the current row unchanged (toggle/delete look
  up the server first; if absent, return `''` for delete or a 204 for toggle). No throw.
- htmx failures surface as an unswapped fragment; there is no destructive path (delete
  has `hx-confirm`).

## 5. Testing (vitest + `app.inject`, no browser)

- **Regression (unchanged):** plain `POST /mcp/:id/toggle`, `/delete`, `/google/*` still
  return 302 (existing tests keep passing).
- **New htmx-path tests** (inject with `headers: { 'hx-request': 'true' }`):
  - toggle → 200, body is a single `#mcp-row-<id>` card showing the flipped state;
  - delete → 200, empty body;
  - google connect → 200, body contains the connected card (`Disconnect`); disconnect →
    the connect card (refresh-token field).
- **Vendor route:** `GET /vendor/htmx.min.js` → 200, `Content-Type` js, non-empty body,
  reachable without auth (in `PUBLIC_PATHS`).
- **Layout:** `layout()` output contains the `<script src="/vendor/htmx.min.js">` tag.
- Keep the whole suite + `npx tsc --noEmit` green.

## 6. Files & boundaries

- **New:** `src/web/vendor/htmx.min.js` (committed asset), `tests/web/htmx.test.ts`.
- **Modify:** `src/web/render.ts` (script tag; layout test), `src/web/server.ts`
  (vendor route + `PUBLIC_PATHS`), `src/web/routes/mcp.ts` (`renderMcpRow`,
  `#google-card` wrapper, `hx-*` attributes, HX-aware toggle/delete/connect/disconnect).
- **Untouched:** models/home/login routes, agent, scheduler, db, crypto, config.

## Risks / notes

- Vendored htmx must be updated manually for new versions — acceptable (rare; a static
  file, pinned version noted in a comment/README).
- `hx-swap="outerHTML"` on delete relies on the row's `#mcp-row-<id>` id being the
  `hx-target`; the id must be unique and present — enforced by `renderMcpRow`.
- CSP: the app sets no restrictive CSP, and htmx is same-origin — no inline-script or
  external-host issues. (If a CSP is added later, htmx is same-origin `/vendor/…`.)
- Keeping the redirect fallback means every enhanced route has two return paths; tests
  cover both to prevent drift.
