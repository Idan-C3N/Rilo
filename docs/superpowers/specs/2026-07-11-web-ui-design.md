# Web UI Restyle + Dashboard — Design

**Date:** 2026-07-11
**Workstream:** #2 of the open-source initiative.
**Status:** Approved design, ready for implementation plan.

## Goal

Turn the near-unstyled web UI into a clean, modern, responsive interface with a
small reusable design system, and add a Home dashboard with a setup-status
checklist. No framework, no build step — hand-written CSS, server-rendered HTML.

## Constraints (locked)

| Decision | Choice |
|---|---|
| Build tooling | **None** — repo runs via `tsx`, no compile. Plain CSS, server-rendered HTML stays. No React/Tailwind/PostCSS. |
| Visual direction | **Clean & minimal** — neutral grays, one blue accent, generous whitespace, system font, subtle card borders/shadows. |
| Theme | **Auto** — CSS custom properties + `@media (prefers-color-scheme: dark)`; light by default, dark to match the OS. |
| Scope | Restyle + light UX polish + a new Home dashboard (the #6 hook). No new app features, no IA changes beyond the dashboard. |

## Non-goals

- No client-side framework or bundler.
- No changes to auth, agent, scheduler, or data model.
- No web-based setup *wizard* — the dashboard only surfaces status + links.
  A full wizard, if ever wanted, is workstream #6 and would reuse this design system.
- No new Services/Models functionality — same flows, restyled.

## Relationship to #6 (setup-agent)

#6 is mostly pre-run, terminal/agent-driven onboarding (explain API keys, fill
`.env`, choose deploy target). The web UI is post-login config for a running
instance. They barely overlap in IA. This workstream helps #6 only by producing a
reusable component vocabulary (layout, cards, forms, buttons, flash) and a Home
dashboard that a future web-wizard could extend — without pre-designing that wizard.

## 1. CSS delivery

- New module `src/web/styles.ts` exports a single `CSS` string constant (the whole
  stylesheet, ~150–200 lines).
- `layout()` inlines it into a `<style>` in `<head>`. Rationale over a served
  `/app.css` route: no new route, no public-path/auth edge case (the pre-auth login
  page needs styles), no CSP concern, no build. The per-page cost (~4KB inline) is
  negligible for this app.
- All theming via CSS custom properties so light/dark is one variable block +
  one `@media (prefers-color-scheme: dark)` override block.

## 2. Design system (in `src/web/render.ts`)

**Tokens** (CSS vars on `:root`, overridden in the dark media query):
`--bg`, `--surface`, `--border`, `--text`, `--muted`, `--accent`, `--accent-text`,
`--danger`, plus `--radius`, spacing scale, `--shadow`.

**Base styles:** system font stack; `body` uses `--bg`/`--text`; `main.container`
`max-width: 720px`, centered, fluid padding; inputs/selects/textareas share a
styled control look with visible `:focus-visible` ring; buttons in three variants
(`.btn` primary, `.btn-secondary`, `.btn-danger`); cards with `--surface` bg,
`--border`, `--radius`, `--shadow`.

**Render helpers** (exported from `render.ts`, all HTML-escaping user data via `esc`):
- `layout(title: string, body: string, opts?: { active?: NavKey; flash?: Flash }): string`
  — full document: `<head>` (title, viewport, inline CSS), `<header>` (brand "Rilo" +
  nav), optional flash banner, `<main class="container">${body}</main>`.
- `card(title: string, body: string): string` — `<section class="card"><h2>…</h2>…</section>`.
- `flash(kind: 'ok' | 'error', msg: string): string` — styled banner.
- `navLink(href: string, label: string, active: boolean): string` — nav item with
  `aria-current="page"` + `.active` when current.
- Types: `type NavKey = 'home' | 'models' | 'services'`; `type Flash = { kind: 'ok' | 'error'; msg: string }`.

Nav renders: `Home (/)`, `Models (/models)`, `Services (/mcp)`, `Log out (/logout)`.

## 3. Information architecture & screens

### Nav / header
Sticky-ish top header with brand + the four nav links; active item highlighted.
Responsive: links wrap on narrow screens (no hamburger needed for 4 items).

### Home `/` — NEW dashboard (`src/web/routes/home.ts`)
Replaces Models as the root page. Renders a "Getting started" card with live status
rows, each linking to the relevant screen:
- **OpenRouter key** — "Set ✅" / "Not set — add one" → `/models`. (`getOpenrouterKey`)
- **Models** — shows current cheap/strong model names → `/models`. (`getConfig`)
- **Services** — "N connected" (count of enabled MCP servers + Google if connected) → `/mcp`.
  (`listMcpServers` + `hasOAuthToken`)

Each row: label, status text/badge, link. Purely informational — no forms.

### Models `/models` (moved off root)
Same two cards (model config, OpenRouter key), restyled. `GET /models` renders them.
- `POST /models` → redirect `/models?saved=models`.
- `POST /openrouter-key` → redirect `/models?saved=key`.
- The GET reads `?saved=` and renders the matching flash ("Models saved ✅" / "Key saved ✅").

### Services `/mcp`
Same content and flows, restyled with the card/button system:
- Built-in (Web Search) card.
- "Your services": connected MCP rows + Google-connected card; nicer empty state
  (icon + one-line hint) when none.
- "Connect a service": Google connect card + preset cards.
- "Advanced" custom-MCP form inside `<details>`.
- Enable/Disable → `.btn-secondary`; Delete → `.btn-danger`.
- Post actions redirect to `/mcp?saved=…` where useful (e.g. `?saved=connected`,
  `?saved=deleted`) to show a flash.

### Login `/login` (in `server.ts`)
Centered single card ("Enter your code"), styled input + primary button. Invalid
code renders a styled `flash('error', …)` instead of the current bare `<p>`.
`/login` GET must remain public (already in `PUBLIC_PATHS`) and now pulls in the
inline CSS automatically via `layout()`.

### Log out `/logout` (NEW, tiny)
Clears the session cookie and redirects to `/login`. Added because the nav exposes
it and there is currently no way to end a session from the UI. Clears the `token`
cookie; the existing session row can remain (it expires by its own TTL).

## 4. UX polish

- **Flash messages** — stateless via query param. POST handlers redirect with
  `?saved=<key>`; the GET handler maps known keys to `flash('ok', msg)`. Unknown/absent
  key → no banner. No server-side session storage needed.
- **Active nav highlight** — `layout(..., { active })` passed per route.
- **Empty states** — Services "no services yet" gets an icon + hint line.
- **Consistent buttons** — primary for main actions, secondary for toggles, danger
  for destructive.

## 5. Error handling

- All dynamic values continue through `esc()` (XSS guard) — unchanged discipline.
- Unknown `?saved=` value → render nothing (no crash, no injection: value is never
  echoed, only matched against a fixed map).
- Login invalid code → styled error flash, same 200 response as today.

## 6. Testing (vitest, no network — matches existing suite)

- **Unit (`tests/web/render.test.ts`, new):**
  - `esc()` escapes `& < > " '`.
  - `layout()` output contains the title, the inline `<style>`, the four nav links,
    and marks the `active` item with `aria-current="page"`.
  - `flash('ok'|'error', msg)` renders the escaped message with the right class.
  - `card(title, body)` wraps in `.card` with an `<h2>`.
- **Route smoke (`tests/web/routes.test.ts`, new) via `app.inject`:**
  - `GET /login` → 200, body contains the code form.
  - Authed `GET /` → dashboard checklist present (build the app with a fake
    session/`userId`, following existing web test patterns; inject a cookie or stub
    `sessionUserId`).
  - `POST /models` → 302 redirect to `/models?saved=models`.
- Keep the whole suite + `npx tsc --noEmit` green.

## 7. Files & boundaries

- **New:** `src/web/styles.ts` (`CSS` constant), `src/web/routes/home.ts`
  (dashboard), `tests/web/render.test.ts`, `tests/web/routes.test.ts`.
- **Modify:** `src/web/render.ts` (design-system helpers + types), `src/web/server.ts`
  (login HTML via new helpers; register home route; add `/logout`; pass `active`),
  `src/web/routes/models.ts` (root → `/models`, flash redirects, `active: 'models'`),
  `src/web/routes/mcp.ts` (restyle to card/button system, flash, `active: 'services'`).
- **Untouched:** agent, scheduler, db, channels, crypto, config, mcp manager/presets.

## Verification / definition of done

- [ ] Every screen uses the new design system; no raw unstyled HTML remains.
- [ ] Light and dark both look correct (`prefers-color-scheme`).
- [ ] Responsive down to ~360px width (login + all screens usable on a phone).
- [ ] Root `/` is the dashboard; Models at `/models`; nav active state correct.
- [ ] Save actions show a flash; invalid login shows a styled error.
- [ ] `/logout` clears the cookie and redirects to `/login`.
- [ ] New + existing tests pass; `npx tsc --noEmit` clean.

## Risks / notes

- Moving Models off `/` changes redirects — every `reply.redirect('/')` that meant
  "back to Models" becomes `/models…`; login success still lands on `/` (now the
  dashboard, a good landing). Audit all `redirect('/')` calls during implementation.
- Inline CSS means no cross-page caching; acceptable for a personal single-process app.
- Dashboard status is read-only and cheap (a few indexed SQLite reads per load).
