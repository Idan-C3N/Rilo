# Magic-link login (drop the 6-digit code)

**Date:** 2026-07-12
**Issue:** #11
**Status:** Approved (brainstorm complete)
**Branch:** `feat/11-magic-link` off `main`

## Goal

The `/login` link alone authenticates — no separate 6-digit code to type. One-time-use
link with token rotation so the URL secret dies on first use and the long-lived session
secret never appears in a URL.

## Decisions (resolved in brainstorm)

1. **One-time-use + rotate** (not reuse-token-as-session). Verifying a link mints a **new**
   session token for the cookie and invalidates the link token.
2. **Remove the 6-digit code entirely** — single login path. No cross-device fallback (add
   later if it bites).
3. **Disable the Telegram link preview** on the login message — Telegram fetches URLs
   server-side to build previews, which would consume the one-time token before the user
   clicks. This is the prefetch mitigation and the design depends on it (Telegram is the
   only delivery channel).

## Current flow (for reference)

- `dispatch.ts`: `/login` → `startLogin` returns `{ token, code }`; bot sends
  `${webBaseUrl}/login?token=X` + "enter this code."
- `server.ts`: `GET /login?token` sets the token as a cookie (unverified) + renders the code
  form; `POST /login` → `verifyCode(token, code)` sets `verified=1`, extends to 7 days.
- The link token **is** the session cookie token (reused post-verify).

## Design

### `db/sessions.ts`

- `startLogin(db, userId)` → returns **`{ token }`** only. Row inserted with `verified=0`,
  10-min `expires_at`, `code` left `NULL` (stop generating it).
- **New** `verifyByToken(db, token): string | undefined`:
  - Look up the row by `token`; reject (`undefined`) if missing, `verified=1` already, or
    `expires_at < now`.
  - Generate a **new** token (`randomBytes(24).toString('hex')`).
  - `UPDATE sessions SET token=<new>, verified=1, expires_at=<now+7d> WHERE token=<old>`.
  - Return the **new** token.
  - Rotating the primary token value delivers both **one-time-use** (the old link token no
    longer resolves) and **rotation** (session secret ≠ URL secret) in one statement.
- **Remove** `verifyCode`.
- `getSession` unchanged.
- The `code` column stays in the schema, unused (always `NULL`) — no migration; flagged as
  dead for a future cleanup.

### `web/server.ts`

- `GET /login?token=X`: call `verifyByToken(db, X)`.
  - Success → `reply.setCookie('token', <newToken>, { path:'/', httpOnly:true })`, redirect `/`.
  - Failure → render a bare page: "This login link is invalid or expired — send `/login` to
    Rilo again for a new one." (HTTP 200, `{ bare:true }` layout, no cookie set.)
- `GET /login` with **no** token → bare page: "Open the login link Rilo sent you on Telegram."
- **Remove** the `POST /login` route and the code form entirely.
- `PUBLIC_PATHS` already contains `/login` — unchanged.

### `channels/adapter.ts` + `channels/telegram.ts`

- Extend the adapter interface:
  `send(channelUserId: string, text: string, opts?: { disableLinkPreview?: boolean }): Promise<void>`.
- Telegram impl (`telegram.ts`): when `opts.disableLinkPreview`, pass
  `link_preview_options: { is_disabled: true }` to `bot.api.sendMessage` (both the
  MarkdownV2 path and the plain fallback). Default (no opts) = current behavior.

### `agent/dispatch.ts`

- `/login` handler: `const { token } = startLogin(db, user.id);`
  `const url = ...`;
  `await deps.adapter.send(m.channelUserId, \`Log in: ${url}\n\n(link expires in 10 minutes, one-time use)\`, { disableLinkPreview: true });`

## Error handling

- Invalid/expired/used token → friendly page, no cookie, no leak of *why* beyond
  "invalid or expired." No stack traces.
- `verifyByToken` is a single atomic `UPDATE` guarded by the `WHERE token=<old> AND verified=0`
  predicate — a double-click / race resolves at most once (second finds the token gone).

## Testing

- **`db/sessions.test.ts`**: `startLogin` returns `{ token }` and stores no code;
  `verifyByToken` on a valid unverified token returns a **new** token, marks verified, sets
  ~7-day expiry; the **old** token no longer resolves (`getSession(old)` undefined,
  `verifyByToken(old)` undefined); expired token → undefined; already-verified token → undefined.
- **`web/login-route.test.ts`**: `GET /login?token=valid` → 302 to `/` with a rotated
  `token` cookie ≠ the URL token; `GET /login?token=bad` → 200 error page, no cookie;
  `POST /login` → 404; `GET /login` (no token) → 200 "check Telegram" page.
- **`channels/telegram.test.ts`**: `send(..., { disableLinkPreview:true })` passes
  `link_preview_options.is_disabled = true`; default send does not.
- **`agent/dispatch.test.ts`**: `/login` sends one message containing the URL, with
  `disableLinkPreview` set, and no 6-digit code in the text.

## Files touched

- `src/db/sessions.ts`, `src/web/server.ts`, `src/agent/dispatch.ts`,
  `src/channels/adapter.ts`, `src/channels/telegram.ts`
- Tests: `tests/db/sessions.test.ts`, `tests/web/login-route.test.ts`,
  `tests/channels/telegram.test.ts`, `tests/agent/dispatch.test.ts`

## Out of scope

- Removing the `code` column (migration) — later cleanup.
- Cross-device code fallback — dropped by decision; revisit if needed.
- Rate-limiting `/login` link generation / verification attempts → **#3 security pass**.
- Any change to the 7-day session TTL or cookie `Secure`/`SameSite` flags → **#3**.

## Verification (Definition of Done)

- `npm test` green (new/updated cases included); `tsc --noEmit` clean.
- Manual: `/login` to the bot → message has a link and **no code**, **no preview card**;
  clicking logs in and lands on `/`; the same link clicked again → "invalid or expired"
  (one-time); the session cookie value differs from the URL token (rotation).

## Conflicts / sequencing

Touches `web/server.ts`, `db/sessions.ts`, `agent/dispatch.ts` — the auth cluster. #1 already
merged (its `server.ts` additions are the OAuth routes, disjoint from the login route). #9
onboarding is not yet started; when it lands it also touches `dispatch.ts` — whichever merges
second rebases. Standalone and safe to build now.
