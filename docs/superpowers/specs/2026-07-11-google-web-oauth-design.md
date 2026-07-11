# Google Web OAuth (opt-in) with loopback/paste fallback

**Date:** 2026-07-11
**Issue:** #1 — Easier connections: real OAuth (Google)
**Status:** Approved (brainstorm complete)
**Agent branch:** own branch off `main`
**Serialization:** touches `web/server.ts` + `web/routes/mcp.ts`. Must **serialize** with #9/#11 (the auth cluster). Safe to run in parallel with #8 (disjoint files).

## Goal

Let an operator who exposes Rilo on a public HTTPS URL offer a one-click
**"Connect with Google"** consent flow instead of the manual run-a-script-and-paste-a-refresh-token
dance — while **keeping the existing loopback/paste flow unchanged** for the default
firewall-only deployment. Both paths end at the same encrypted refresh token in
`db/oauth.ts`, so nothing downstream changes.

## Decisions (resolved in brainstorm)

1. **Support both, gated by an explicit flag.** Reachability cannot be reliably
   auto-detected, so public OAuth is opt-in via `ENABLE_WEB_OAUTH` (default `false`).
   - `false` (default, firewalled): current loopback/paste card, **zero behavior change**.
   - `true`: "Connect with Google" button → real authorization-code flow.
2. **Loopback/paste fallback stays** (it is the default and the firewalled path).
3. **Google only.** Slack stays token-paste via the existing MCP preset. The new
   routes are provider-generic (`/oauth/:provider/...`) so Slack OAuth can be added
   later without rework, but no Slack OAuth in this issue.
4. **CSRF:** `state` param carried in a short-lived signed cookie, validated on callback.

## Architecture

### Config (`src/config.ts`)

- Add `enableWebOauth: boolean` ← `ENABLE_WEB_OAUTH` (`'true'` → true, default false).
- Reuse existing `googleClientId` / `googleClientSecret`.
- `webBaseUrl` already exists — it is the base for `redirect_uri`.
- Add to `.env.example` with a comment explaining it requires a public HTTPS `WEB_BASE_URL`
  and a matching **Web application** OAuth client redirect registered in Google Cloud.

### OAuth flow (new routes, `src/web/`)

New route module `src/web/routes/oauth.ts`, registered from `server.ts`, provider-generic
but only `google` implemented:

**`GET /oauth/google/start`** (authenticated — the logged-in owner initiates):
- Build the Google consent URL with `google-auth-library` `OAuth2Client`
  (`{ clientId, clientSecret, redirectUri: ${webBaseUrl}/oauth/google/callback }`),
  `access_type: 'offline'`, `prompt: 'consent'`, `scope: GOOGLE_SCOPES`
  (reuse the exported constant from `src/agent/google/client.ts`).
- Generate a random `state` (24 random bytes, base64url — reuse the token style already
  used for sessions). Set it in a signed, `httpOnly`, short-TTL (10 min) cookie
  `oauth_state`. Also stash the initiating `userId` — either in the same signed cookie
  or keyed server-side — so the callback binds the token to the right user even though
  the callback path is public.
- `reply.redirect(authUrl)` with `state` appended.

**`GET /oauth/google/callback`** (in `PUBLIC_PATHS` — arrives with no session cookie):
- If `!enableWebOauth` → 404 / redirect to `/mcp` (inert when flag off).
- Read `code` + `state` from query. Read `oauth_state` cookie. **Reject** (redirect to
  `/mcp` with an error flash) if state missing or mismatched.
- Exchange `code` → tokens via `OAuth2Client.getToken(code)`.
- If `tokens.refresh_token` present → `setOAuthToken(db, userId, 'google', refresh_token)`
  (userId from the signed state cookie). If absent (Google omits it when already
  granted) → error flash instructing to revoke at myaccount.google.com and retry
  (same guidance the loopback helper prints).
- Clear the `oauth_state` cookie. Redirect to `/mcp?saved=google`.

**Security invariants** (also feed #3's audit):
- Callback in `PUBLIC_PATHS` but does nothing unless `enableWebOauth` **and** a valid
  `state` cookie match — no unauthenticated write path when the flag is off.
- `state` cookie: signed (`@fastify/cookie` is already registered), `httpOnly`,
  `sameSite: 'lax'` (needed — the callback is a top-level cross-site redirect from Google),
  short TTL.
- Token exchange failures return a generic flash; no stack traces to the client.

### UI (`src/web/routes/mcp.ts`)

`registerMcpRoutes` already receives `opts` and renders the Google card. Thread a new
`enableWebOauth: boolean` into `opts` (from `server.ts`, from `appCfg`). Then:

- **`renderGoogleConnect`** (not-connected card):
  - `enableWebOauth === true` → replace the "run the loopback helper + paste" block with
    a single **Connect with Google** button that is a link/`GET` to `/oauth/google/start`
    (a real navigation, not htmx — it leaves the site for Google).
  - `enableWebOauth === false` → **unchanged** (current loopback/paste instructions + form).
- **`renderGoogleConnected`** (connected card): unchanged. Disconnect still hits
  `/google/disconnect`.
- The existing `POST /google/connect` (paste) route **stays** — it is the fallback and is
  still used when the flag is off. No change to it.

### `server.ts`

- Add `'/oauth/google/callback'` to `PUBLIC_PATHS`.
- Extend `WebDeps.appCfg` pick to include `enableWebOauth`.
- Register `registerOauthRoutes(app, db, { appCfg })`.
- Pass `enableWebOauth` into `registerMcpRoutes` opts (alongside the existing
  `googleEnabled`).

## Files touched

- `src/config.ts` — `enableWebOauth`
- `src/web/routes/oauth.ts` — **new**, start + callback
- `src/web/routes/mcp.ts` — Connect-button vs paste card branch on `enableWebOauth`
- `src/web/server.ts` — PUBLIC_PATHS, register oauth routes, thread flag
- `.env.example` — `ENABLE_WEB_OAUTH` + note on Web-application OAuth client
- `deploy/` — note that public OAuth needs an HTTPS reverse proxy + registered redirect
  (documentation only; do not force a proxy on firewalled installs)
- `scripts/google-auth.ts` — **kept** (loopback fallback). Add a one-line comment that
  it is the fallback used when `ENABLE_WEB_OAUTH` is off.

## Testing

- **`oauth.ts` unit/route tests** (mirror `tests/web/*-route.test.ts`, build the app with
  a fake `getToken`):
  - `start` with flag on → 302 to a Google URL containing `state`, `redirect_uri`,
    the scopes; sets a signed `oauth_state` cookie.
  - `callback` with matching `state` + fake token exchange returning a refresh token →
    `setOAuthToken` called with the initiating userId; redirect `/mcp?saved=google`.
  - `callback` with **missing/mismatched** `state` → rejected, no token stored.
  - `callback` when `enableWebOauth` is **false** → inert (404/redirect), no token stored.
  - token exchange returns **no** refresh_token → error flash, no store.
- **`mcp.ts` render test:** flag on → card contains "Connect with Google" link to
  `/oauth/google/start`, no paste form; flag off → paste form present (current behavior).

## Out of scope

- Slack OAuth (stays paste).
- Reverse-proxy / TLS automation in `deploy/` (documented, not automated).
- Rate limiting on the callback → **#3** security pass.
- README connect-a-service copy → **#5**.

## Verification (Definition of Done)

- `npm test` green; `npm run build` clean.
- With `ENABLE_WEB_OAUTH` unset: Services page identical to today; paste flow works.
- With `ENABLE_WEB_OAUTH=true` + a reachable `WEB_BASE_URL` + a Web-application OAuth
  client: clicking Connect with Google completes consent and lands back with Google
  connected; the stored refresh token drives the existing Gmail/Calendar tools unchanged.
- State mismatch is rejected.
