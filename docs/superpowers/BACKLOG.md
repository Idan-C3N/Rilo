# Rilo Open-Source Backlog

**Updated:** 2026-07-13
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
- **#9 — onboarding + owner approval** (self-service `/register`; `OWNER_TELEGRAM_ID` auto-owned on boot; owner `/approve|/deny` + web Pending list) — merged (PR #3).
- **#11 — magic-link login** (link's token is the sole factor; dropped the 6-digit code) — merged (PR #2).
- **Public HTTPS + web OAuth LIVE on the box** — Caddy TLS overlay (`compose.caddy.yml` + `deploy/Caddyfile`, auto Let's Encrypt on **`rilo.my`**); Hetzner firewall 80/443 opened + DNS zone/A-record via `hcloud`; `ENABLE_WEB_OAUTH=true` with a Google **Web** OAuth client. Verified end-to-end in prod (2026-07-12).
- **Live-box migration systemd → Docker Compose** — done 2026-07-12 (DB + `.env` preserved; systemd unit disabled). The box now runs `docker compose -f compose.yml -f compose.caddy.yml`. `rilo-deployment` memory updated with the new redeploy command + gotchas.
- **Semantic memory recall via embeddings** — bundled internal **TEI `multilingual-e5-small`** (384-d) container; vectors as `BLOB` in the `memory` table, brute-force cosine, best-effort embed-on-write + boot backfill + substring fallback. Merged + live; cross-lingual recall verified (English query → Hebrew memories). Spec/plan in `docs/superpowers/`.
- **Structured logging (pino)** — full request-lifecycle logging keyed by a per-message `turnId` (`inbound` / `turn.start` / `llm.done` with tools + token usage / `reply` / errors); token+phone redaction; `LOG_LEVEL` env; apology-to-user on turn failure (was silent); `GenerateFn` widened to surface the SDK's `usage`+`steps`. Merged + live.

## New follow-ups (from the deploy/OSS session)

- ~~**Live-box migration**~~ — **done** (2026-07-12, see Done). The box runs Docker Compose + Caddy public HTTPS; systemd retired.
- **Pin container images** — `compose.yml` uses `searxng/searxng:latest` **and** `text-embeddings-inference:cpu-latest`; pin tags for both before trusting them in prod.
- **README quickstart** — the public repo's root README still predates all this (folded into #5).
- **Recall threshold tuning** — semantic recall defaults to cosine `threshold = 0.80`; live e5 scores are compressed, so borderline-relevant memories (~0.78) get dropped. Lower to ~**0.72** (and reconsider `k`). Small edit in `db/memory.ts` `recallVector`.
- **`mkey` consistency (cosmetic)** — the agent labels memories inconsistently (English vs Hebrew keys). Harmless (recall is by vector), but a prompt tweak could standardize.

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

## #14 — Recurring reminders  ·  effort: M  ·  needs brainstorm

**Goal:** Let a user set a **repeating** reminder ("remind me every Monday 09:00",
"every day at 15:30", "every 2 hours") — not just a one-shot.

**Current (verified 2026-07-13):** does not exist.
- `remind` tool is **one-shot only** — input `delay_minutes`, fires once
  (`agent/tools/remind.ts:6-20`). `track` is likewise one-shot `followup`
  (`track.ts:11-23`).
- Scheduler polls every 15s, fires, then `markDone` — **no re-arm** for
  reminders/followups (`scheduler/scheduler.ts:19-33`, `db/jobs.ts:43-45`).
- `jobs` table has **no recurrence/cron/next_run** column — only `user_id`, `fire_at`,
  `status` (`db/schema.sql:48-57`). Job types are `reminder|followup|heartbeat`.
- The **only** recurring construct is the heartbeat, which re-arms itself each fire
  (`scheduler/heartbeat.ts:49-54`) at a fixed per-user interval with model-chosen
  content — a proactive check-in, **not** a user-defined recurring reminder. Do not
  conflate the two, but **reuse its self-reschedule pattern**.

**Approach sketch (resolve in brainstorm):**
- Add a recurrence descriptor to `jobs` (options: (i) simple `interval_min` for
  "every N min", (ii) a cron string, (iii) RRULE). Recommend starting with **cron**
  (covers "every Monday 09:00" + "every day 15:30" + "every N hours" in one field);
  add a `recurrence` (nullable) column, keep NULL = one-shot (backward compatible).
- On fire, if recurrent, compute the next `fire_at` and re-insert/re-arm instead of
  terminal `markDone` (mirror `heartbeat.ts:49-54`).
- `remind` tool gains an optional recurrence arg; agent parses natural language
  ("every Monday") → cron. Add a `list_reminders` / `cancel_reminder` tool — recurring
  reminders need management (one-shots didn't).

**Open decisions (brainstorm):**
1. **Recurrence model:** interval-only (simple) vs cron (flexible) vs RRULE (full).
   Recommend cron.
2. **Timezone for cron** — reuse existing `users.tz` (`schema.sql:4`, default `'UTC'`,
   already used by `quiet.ts`); confirm DST handling in the cron lib.
3. **Management surface:** list/cancel/edit tools + a web UI list of active reminders
   (none today).
4. **Missed fires** (box down over a fire time): skip vs catch-up.

**Files (rough):** `db/schema.sql` (+`recurrence` on `jobs`, migration — existing rows
NULL/one-shot), `db/jobs.ts` (recurrence-aware add/query/re-arm),
`scheduler/scheduler.ts` + `scheduler/fire.ts` (re-arm on fire), `agent/tools/remind.ts`
(recurrence arg), maybe new `agent/tools/reminders.ts` (list/cancel), `web/` (manage
reminders). **Tests:** recurrence re-arms and fires N times; one-shot unchanged;
cron→next_run math; migration leaves old rows one-shot.

**Conflicts:** `db/jobs.ts` + `scheduler/*` (isolated from the auth cluster — low
contention). **Prereq for #15** (shared-space reminders build on this schema work).

---

## #15 — Shared-space reminders  ·  effort: M  ·  needs brainstorm  ·  after #14

**Goal:** Let a reminder be **shared** to a space so all members get it (household:
"trash out Tuesday night", "pick up kids 15:30") without each person setting their own.

**Current (verified 2026-07-13):** does not exist.
- `jobs` carry only `user_id`, **no `space_id`** (`db/schema.sql:48-57`, `db/jobs.ts:5-35`).
- Delivery is keyed strictly on `job.user_id` (`scheduler/fire.ts:13-29`) — no fan-out.
- Space scoping exists today **only** for `memory` (`schema.sql:66`, `db/memory.ts:14-26`),
  via `spaces`/`space_members` (`db/spaces.ts`, merged with #12). The `remember` tool
  already exposes an optional `space` name (`agent/tools/memory.ts:19-27`) — mirror it.

**Approach sketch (resolve in brainstorm):**
- Add `space_id` (nullable) to `jobs`, mirroring `memory.space_id`.
- At fire time, if `space_id` set, **fan out**: resolve `space_members`
  (`db/spaces.ts listMembers`) → deliver to each member's channel identity
  (generalize `fire.ts` beyond single `job.user_id`), respecting each member's quiet
  hours (`scheduler/quiet.ts`).
- `remind` tool gains an optional `space` name (mirror `remember`); membership-gated.

**Open decisions (brainstorm):**
1. **Fan-out semantics:** one job fanned to N members vs N per-member jobs; dedupe.
2. **Authorization:** who can create/cancel a space reminder — any member vs owner.
3. **Quiet hours** per member on shared delivery.
4. Interaction with #3 security (a shared reminder is an amplification/authorization
   surface — one member schedules messages to others).

**Files (rough):** `db/schema.sql` (+`space_id` on `jobs`, migration), `db/jobs.ts`
(space-aware add/query), `scheduler/fire.ts` (fan-out to members), `agent/tools/remind.ts`
(+`space` arg, membership gate), `web/` (show space reminders). **Tests:** space
reminder fans out to all members; non-members excluded; quiet-hours honored per member;
personal reminders unaffected.

**Conflicts:** `db/jobs.ts` + `scheduler/fire.ts` (shared with #14 — **serialize after
#14**). Builds on #12's spaces model (merged).

---

## Suggested sequencing (updated)

1. ~~#8 ∥ #1~~ — **both merged**. Public repo pushed.
2. ~~#9 onboarding + #11 magic-link~~ — **both merged** (PR #3, PR #2).
3. ~~Live-box migration + public HTTPS/web-OAuth + embeddings + logging~~ — **all merged + live** (2026-07-12).
4. **#3 security pass** — pressing now that the repo is public **and internet-exposed** (Caddy on 80/443). Audit sessions/CSRF/rate-limit/deps/error-leak; fix; test. **Do next.**
5. **#12 shared/household memory** — after security; touches `dispatch.ts` + `db/memory.ts` (now also the embedding columns).
6. **#5 README** rewrite (reflect SearXNG default, single-Compose + Caddy deploy, web-OAuth, embeddings).
7. **#13 deploy skill** — capture the now-proven deploy runbook as a guided skill.
8. **#14 recurring reminders** — new; ideally after #3 security. Prereq for #15.
9. **#15 shared-space reminders** — new; **after #14** (same `jobs`/`fire.ts` surface) + builds on #12 (merged).
10. **Small follow-ups** — pin image tags; recall threshold 0.80→~0.72.
