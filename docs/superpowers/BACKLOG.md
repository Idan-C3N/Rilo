# Rilo Open-Source Backlog

**Updated:** 2026-07-12
**Purpose:** Coordination doc for the remaining open-source workstreams — approach
sketch, files touched, open decisions, and how to parallelize across agents.

> These are **sketches, not approved specs.** Each open issue should still go through
> `superpowers:brainstorming` (resolve the flagged decisions) → spec → plan → build.
> The point of this doc is to let you farm work to multiple agents without collisions.

## Done

- **#2 — Web UI** (design system, clean/minimal auto light-dark, Home dashboard, styled login + `/logout`, flash) — merged to `main`.
- **#2-ext — OpenRouter model catalog** (live datalist model pickers; new-user defaults seeded by recency from the catalog; `DEFAULT_MODEL_FAMILY`) — merged.
- **#4 — Repo split** (history scrubbed; MIT license) — merged. **Now public** (see below); the systemd/Hetzner split it introduced was later superseded by the single-Compose rework.
- **#7 — docs decision** — superpowers specs are published (verified secret-free); a user-facing `docs/` grows with #5.
- **#10 — htmx progressive enhancement** (vendored htmx; Services toggle/delete + Google connect/disconnect swap inline; JS-off fallback) — merged.
- **#8 — pluggable search backends** (SearXNG bundled default + Google Custom Search opt-in + Tavily demoted to `SEARCH_BACKEND=tavily`; `selectSearchBackend` precedence) — merged + pushed. Spec + plan in `docs/superpowers/`.
- **Deploy rework — single root Docker Compose** (retired systemd; `compose.yml`+`Dockerfile`+`searxng/` at root; bind-mount `./data`; `.env` for secrets, invariants baked into compose; `deploy/provision.sh`; git-pull redeploy) — merged + pushed. Spec: `2026-07-11-single-compose-deploy-design.md`.
- **`dev` script fix** — `npm run dev` now loads `.env` (was crashing on missing `DB_PATH`) — pushed.
- **Public repo** — pushed to `github.com/Idan-C3N/Rilo` (PUBLIC). History verified secret-clean; all commits re-identified to the personal `Idan-C3N <idanco32@gmail.com>` (work identity scrubbed off).
- **#1 — Google web OAuth** (opt-in `ENABLE_WEB_OAUTH`; `/oauth/google/start`+`/callback`; signed-cookie CSRF `state`; loopback/paste kept as firewalled fallback; Slack still paste) — **merged via PR #1** + manually verified end-to-end. Spec: `2026-07-11-google-web-oauth-design.md`.

## New follow-ups (from the deploy/OSS session)

- **Live-box migration** — the Hetzner VPS still runs the **old systemd** setup. Migrate it to Compose using the DB-backup-first sequence in the single-compose spec. Until then the `rilo-deployment` memory's redeploy command (`deploy.sh` + systemd) is still what the live box uses.
- **Pin the SearXNG image** — `compose.yml` uses `searxng/searxng:latest`; pin a tag before trusting it in prod.
- **README quickstart** — the public repo's root README still predates all this (folded into #5).

## File-contention map (why parallelism is limited)

| Issue | Primary files | Hot shared files |
|---|---|---|
| #8 search | `agent/tools/websearch.ts`, `config.ts`, `index.ts`, README | (config/index append-only) |
| #1 OAuth | `db/oauth.ts`, `web/server.ts`, `web/routes/mcp.ts`, `mcp/presets.ts`, `config.ts`, `scripts/` | **server.ts, mcp.ts** |
| #9 onboarding | `agent/dispatch.ts`, `db/users.ts`, `web/*`, `config.ts` | **server.ts, dispatch.ts** |
| #11 magic-link | `db/sessions.ts`, `web/server.ts`, `agent/dispatch.ts` | **server.ts, dispatch.ts** |
| #5 README | `README.md`, `docs/` | (depends on #1/#8) |
| #3 security | cross-cutting | everything |

**`web/server.ts` and `agent/dispatch.ts` are the collision points.** #1, #9, #11 all
touch them → they must **serialize** among themselves. #8 is isolated.

## Recommended parallelization

- ~~**Wave 1 (parallel):** **#8** ∥ **#1**~~ — **done**: #8 merged; #1 built on its branch (merge pending). Deploy rework + public push also landed.
- **Wave 2 (serialize — same files):** **#9**, then **#11**. (Consider merging them into one "auth & onboarding" workstream since both rewrite the login/dispatch path.)
- **Wave 3:** **#5 README** (#8 done; needs #1 merged), then **#3 security**.
- **⚠️ re-prioritize:** the repo is now **public**, so **#3 security** is no longer safely "last" — the un-audited auth surface is exposed. Do it soon, independent of the waves.

Each agent should work on its **own branch** off `main` and merge back when its
workstream's final review passes (same subagent-driven flow used so far).

---

## #8 — pluggable search backends  ·  ✅ DONE (merged + pushed)

**Shipped:** SearXNG bundled default + Google Custom Search opt-in + Tavily demoted (`SEARCH_BACKEND=tavily`), behind `selectSearchBackend` precedence. Design landed differently from the sketch below (SearXNG default, not Google) — see `docs/superpowers/specs/2026-07-11-websearch-backends-design.md`. Original sketch kept below for history.

**Goal:** Let web search use Google Programmable Search (Custom Search JSON API) instead of / alongside Tavily.

**Current:** `agent/tools/websearch.ts` already abstracts the backend behind an injectable `SearchFn`; `tavilySearch(apiKey)` is the only impl, wired in `index.ts` from `TAVILY_API_KEY`. Tool interface is stable (`{title,url,content}[]`).

**Approach:** Add `googleSearch(apiKey, cx): SearchFn` next to `tavilySearch` (call `https://www.googleapis.com/customsearch/v1?key=&cx=&q=`, map `items[]` → `{title, url, content: snippet}`). Add `GOOGLE_SEARCH_KEY` + `GOOGLE_SEARCH_CX` to config + `.env.example`. In `index.ts`, pick the backend from whichever env is set.

**Open decisions:** (a) replace Tavily, or support both and prefer one? Recommend **support both**, prefer Google if its keys are set, else Tavily. (b) result count / snippet trimming.

**Files:** `agent/tools/websearch.ts`, `config.ts`, `index.ts`, `.env.example`, README mention. **Tests:** inject a fake fetch for `googleSearch` (mirror the Tavily test).

**Conflicts:** none meaningful (config/index edits are additive).

---

## #1 — Easier connections: real OAuth (Google)  ·  ✅ DONE (merged PR #1)

**Status:** brainstormed → spec (`2026-07-11-google-web-oauth-design.md`) → built + self-reviewed → **merged via PR #1** + manually verified end-to-end (local Web-app client, consent → callback → Gmail/Calendar tools work). Scope: **Google only** (opt-in via `ENABLE_WEB_OAUTH`, default off; loopback/paste kept as the firewalled fallback; signed-cookie CSRF `state`). **Slack stays token-paste** (deferred). Prod note: publish the OAuth consent screen to **Production** (Testing mode expires refresh tokens after 7 days).

**Goal:** Replace manual token-paste with a real "Connect" → provider consent → callback flow.

**Current:** Google = run `scripts/google-auth.ts` loopback helper locally, paste the refresh token into the UI. Slack = MCP preset, paste `xoxb-…`. Both stored via `db/oauth.ts` (Google) / MCP creds (Slack).

**Approach:** OAuth 2.0 authorization-code flow with the app hosting the callback:
- Add routes `GET /oauth/:provider/start` (redirect to consent) and `GET /oauth/:provider/callback` (exchange code → tokens, store encrypted via `db/oauth.ts`).
- `redirect_uri = ${WEB_BASE_URL}/oauth/:provider/callback`.
- Google: OAuth client type **Web application** (not Desktop) with that redirect; scopes = Gmail + Calendar. Reuse `GOOGLE_CLIENT_ID/SECRET`. Retire `scripts/google-auth.ts`.
- Slack: OAuth v2 (`SLACK_CLIENT_ID/SECRET`), store bot token; feed it to the existing Slack MCP preset instead of manual paste.

**Open decisions (brainstorm these):**
1. `redirect_uri` when `WEB_BASE_URL` is `localhost` (fine for local) vs a public server (owner reachable) vs firewalled — how do self-hosters register a redirect? (Likely: document "set WEB_BASE_URL to a URL Google can reach, or use the loopback helper as fallback.")
2. Keep the loopback/paste path as a fallback for firewalled installs?
3. Slack: full OAuth vs keep token-paste (OAuth needs a public redirect; may be heavier than it's worth).
4. CSRF `state` param handling on the callback.

**Files:** `db/oauth.ts`, `web/server.ts` (+ callback routes, PUBLIC_PATHS for callback), `web/routes/mcp.ts` (Connect buttons → `/oauth/start`), `mcp/presets.ts` (Slack), `config.ts` (+Slack client env), maybe remove `scripts/google-auth.ts`. **Tests:** mock the token exchange.

**Conflicts:** `web/server.ts`, `web/routes/mcp.ts` (with #9/#11). Serialize with the auth cluster.

---

## #9 — Better onboarding / allowlist  ·  effort: M  ·  needs brainstorm

**Goal:** Stop hand-editing SQL to allowlist users. First-message flow should be self-service or one-tap for the owner.

**Current:** A new inbound identity creates a user row (un-allowlisted) *before* the allowlist gate; the owner must run `UPDATE users SET allowlisted=1 …` by hand.

**Approach options (pick in brainstorm):**
1. **Env owner + notify + approve (recommended):** `OWNER_TELEGRAM_ID` in `.env` is auto-allowlisted on boot; when a new user messages, the owner gets a Telegram ping ("X wants access") and approves via a bot command (e.g. `/approve <id>`) or a web "Pending users" list with Approve buttons.
2. **Invite codes/links:** owner generates a one-time code; new user redeems on first message.
3. Web-only pending queue (no Telegram notify).

**Open decisions:** mechanism (1/2/3); how the owner is identified (env id vs first-user-wins); approve via bot command vs web UI vs both.

**Files:** `config.ts` (`OWNER_TELEGRAM_ID`), `agent/dispatch.ts` (gate + notify + approve command), `db/users.ts` (pending/approve helpers), `web/` (pending list + approve route), possibly `index.ts` (seed owner). **Tests:** dispatch gate + approve path.

**Conflicts:** `agent/dispatch.ts`, `web/server.ts` (with #1, #11). **Serialize** with #11 — both rewrite `dispatch.ts`/login.

---

## #11 — Magic-link login (drop the 6-digit code)  ·  effort: S-M  ·  needs brainstorm

**Goal:** The `/login` link alone logs the user in — no separate code to type.

**Current:** Bot sends a link with `?token=` **and** a 6-digit code. `/login?token` stores the token in a cookie; the user then types the code, `verifyCode` marks the session verified. Two steps.

**Approach:** Make the link's token the sole factor. `GET /login?token=X` looks up the session by token, marks it verified, sets the cookie, redirects to `/`. Drop the code form. `db/sessions.ts`: add `verifyByToken(token)`; `startLogin` no longer needs to surface a code (or keep it for a manual fallback).

**Security (cover in brainstorm):** one-time use (invalidate token after first successful use); keep the short TTL (currently 10 min); token entropy is already 24 random bytes (good); note that anyone with the link within its window is in — acceptable since it's delivered over the user's authenticated Telegram.

**Open decisions:** one-time-use on/off; keep the code path as a fallback or remove entirely; wording of the bot message.

**Files:** `db/sessions.ts`, `web/server.ts` (login GET verifies token; remove code form/POST), `agent/dispatch.ts` (`/login` message text). **Tests:** token-verifies-session; expired/reused token rejected.

**Conflicts:** `db/sessions.ts`, `web/server.ts`, `agent/dispatch.ts` (with #9). **Serialize** with #9.

---

## #5 — README rewrite for OSS  ·  effort: M  ·  do after #1, #8

**Goal:** A README that gets a stranger from clone → running fast, and documents the OSS project honestly.

**Current:** Root `README.md` is author/Hetzner-first, doesn't point at `deploy/README.md`, predates the new UI/catalog, mentions Tavily (may change with #8).

**Approach:** Rewrite: what Rilo is (one-paragraph), a Docker quickstart, a **required API keys table** (Telegram, OpenRouter, optional Tavily/Google-search, Google/Slack), link to `deploy/README.md` for deploy paths, "connecting services" (reflecting #1's outcome), the model-defaults behavior, and a short Contributing/architecture pointer. Keep operator-specific bits out (they live in `instance.local.md`).

**Open decisions:** depth of architecture docs in `docs/` vs README; badges; screenshots of the new UI.

**Files:** `README.md`, new `docs/*.md` (architecture, adding-a-service). **No tests.**

**Conflicts:** docs-only; but content depends on #1 and #8 being final — schedule after them.

---

## #3 — Security + code-quality pass  ·  effort: M  ·  do LAST

**Goal:** Pre-publish audit + fixes; a clean bill before the repo goes public.

**Scope (audit → findings → fixes):**
- **Session/cookies:** `Secure` flag when served over HTTPS; `SameSite`; `httpOnly` (already set). Token TTL/rotation.
- **CSRF:** POST forms have no CSRF token (deferred earlier; acceptable under firewall+localhost, revisit for public exposure).
- **Rate limiting** on `/login` code/token attempts.
- **Secrets:** confirm encryption-at-rest coverage (`crypto/encryption.ts`), no secrets in logs, `.env`/`instance.local.md` never committed (already gitignored).
- **Input validation** on web forms + MCP creds; SQL is parameterized (verify no string interpolation).
- **Dependency audit:** `npm audit`; pin/patch.
- **Error leakage:** no stack traces or internal detail to the client.
- **Allowlist/authorization** consistency across reactive/scheduled/heartbeat paths.

**Approach:** run it as a review workstream — a security-focused whole-repo review (opus) producing a ranked findings list, then a fix pass. Do **after** #1/#9/#11 land (they change the exact surfaces being audited).

**Files:** primarily `web/`, `crypto/`, `db/sessions.ts`, `config.ts`, `package.json`. **Tests:** add for each fix.

---

## #12 — Shared memory between people (household/group)  ·  effort: L  ·  needs brainstorm

**Goal:** Let two or more allowlisted users share a common memory space so the agent has shared context across them — e.g. Idan + wife sharing household facts ("kids' school pickup is 15:30", "our anniversary is …", shopping list) without each having to re-teach the bot.

**Current:** memory is per-user — `db/memory.ts` rows are keyed by `user_id`; `agent/tools/memory.ts` reads/writes only the calling user's memories; dispatch assembles context from that single user. No concept of a group.

**Approach sketch (resolve in brainstorm):**
- Introduce a **group/space** (e.g. `groups` + `group_members`, or a shared `space_id` on memory rows). A memory has a scope: **personal** (default) or **shared(space)**.
- Memory tool gains a scope arg / the agent decides: "remember for the household" → shared; personal stays default. Context assembly merges the caller's personal memories **+** the shared-space memories.
- Web UI: create/name a space, invite another allowlisted user, see/manage shared memories, leave a space.

**Open decisions (brainstorm):**
1. **Grouping model:** one implicit "household" per install vs named multi-space groups vs pairwise sharing.
2. **Membership/invite:** owner adds a user to the space (ties into #9 onboarding) vs invite code vs auto (all allowlisted users share one space).
3. **Write/read semantics:** can everyone write shared memories, or read-only for some? Can a member delete another's shared memory?
4. **Scope choice:** does the agent auto-classify personal vs shared, or must the user say "remember for us"? Default scope?
5. **Privacy boundary:** guarantee personal memories never leak into another member's context; make "shared" visibly distinct in the tool + UI.
6. **Attribution:** track who wrote a shared memory (useful for trust + deletion rules).
7. **Interaction with per-user model/keys:** shared memory, but each user still uses their own OpenRouter key/model.

**Files (rough):** `db/memory.ts` (scope/space columns + queries), `db/users.ts` or new `db/groups.ts` (membership), `agent/tools/memory.ts` (scope-aware read/write), `agent/dispatch.ts` / context assembly (merge personal + shared), `web/` (manage spaces + members + shared memories), migration for existing rows (default personal). **Tests:** scope isolation (personal never bleeds), shared read/write across members, membership gates.

**Conflicts:** `agent/dispatch.ts` (with #9/#11 auth cluster) + `db/memory.ts`. Depends conceptually on #9 (how users/groups are managed). Sequence **after** the auth/onboarding work.

---

## #13 — Deploy skill: guide agents to deploy Rilo  ·  effort: S-M  ·  needs brainstorm

**Goal:** A reusable **skill** (superpowers-style `SKILL.md`) that walks an agent
through deploying this personal assistant end-to-end, so a fresh agent (or a new
self-hoster's agent) can stand Rilo up without rediscovering the whole runbook.

**Current:** deploy knowledge is scattered — `deploy/README.md` (Compose +
Caddy + OAuth prereqs), `deploy/provision.sh`, and the `rilo-deployment` agent
memory (server IP, firewall, hcloud, redeploy command). No single guided
procedure; the last two deploys (systemd→Compose migration, public-HTTPS + web
OAuth) were done ad-hoc from live investigation.

**Approach sketch (resolve in brainstorm):**
- Encode the real procedure we ran: provision box → Docker Compose up → data/.env
  preserve → firewall (Hetzner 80/443 + SSH/8080) → DNS zone + A record → Caddy
  TLS overlay (`compose.caddy.yml`) → `ENABLE_WEB_OAUTH` + Google Web client →
  bundled `embed`/`searxng` containers → verify (cert, `/health`, bot polling).
- Capture the **gotchas hit live**: container uid 1001 vs host data uid → chown;
  `.env` trailing-newline append bug; `!reset` app ports under the overlay;
  Telegram getUpdates single-poller (stop old process before new).
- Include verification commands + a rollback path (backup dir, revert overlay).
- Decide scope: generic "deploy anywhere" vs Hetzner-specific; whether it drives
  the firewall via `hcloud` or documents console steps.

**Open decisions:** (a) generic vs Hetzner-opinionated; (b) how much it automates
vs instructs; (c) where it lives (repo `skills/` vs the agent's global skills);
(d) how it consumes per-install secrets/instance facts (`instance.local.md`).

**Files:** new `SKILL.md` (+ any helper scripts), references into `deploy/`.
**No app tests** (docs/skill); validate by having an agent follow it on a fresh box.

**Conflicts:** none (additive docs/skill).

---

## Suggested sequencing (updated)

1. ~~#8 ∥ #1~~ — **both merged** to `main`. Public repo pushed.
2. **#3 security pass** — pressing now that the repo is public. Audit sessions/CSRF/rate-limit/deps/error-leak; fix; test.
3. **#9** onboarding, then **#11** magic-link (or combine) — serialize (both touch `dispatch.ts`/login).
4. **#12 shared/household memory** — after the auth/onboarding cluster (depends on how users/groups are managed; touches `dispatch.ts` + `db/memory.ts`).
5. **#5 README** rewrite (reflect #8 SearXNG default, single-Compose deploy, #1 outcome).
6. ~~**Live-box migration** systemd → Compose~~ — **done** (migrated 2026-07-12; box now runs Compose + Caddy public HTTPS + web OAuth + bundled embed/searxng).
7. **#13 deploy skill** — capture the now-proven deploy runbook as a guided skill.
