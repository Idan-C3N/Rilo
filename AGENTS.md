# AGENTS.md — Rilo personal agent

Guide for AI coding agents working in this repo. Read this before making changes.

## What this is

**Rilo** — a personal AI assistant reached over Telegram (WhatsApp-ready). It chats
reactively, fires reminders at any horizon, autonomously self-checks on a heartbeat,
remembers durable facts, does web search, and supports per-user "Services" (MCP
integrations). Multi-user, isolated, all-equal, allowlist-gated. Runs as one Node
process on a cheap VPS; SQLite for all state.

## Stack & conventions

- **Node 22+, TypeScript, ESM.** `"type": "module"`. Import paths use `.js`
  extensions (e.g. `import { openDb } from './db/db.js'`) even for `.ts` files.
- **Run/build via `tsx`** — no compile step. `tsx` is a **runtime dependency** (prod
  runs `node --import tsx src/index.ts`).
- **TS strict** incl. `noUncheckedIndexedAccess` — index access is `T | undefined`;
  use `arr[0]!` in tests when you know it exists.
- **SQLite via `better-sqlite3`** — synchronous API, no `await` on queries.
- **Vitest.** Tests never hit real Telegram / OpenRouter / MCP / network — inject
  fakes. Every repo query is scoped by `user_id`; secrets encrypted at rest.
- **Commit freely** on a feature branch (this is a personal project). Keep the full
  suite + `npx tsc --noEmit` green before committing.

## Commands

```bash
npm install
npm test              # vitest run (whole suite)
npx tsc --noEmit      # typecheck (must be clean)
npm start             # run the app (loads .env)
```

## Layout (src/)

- `config.ts` — env → typed `AppConfig` (`loadConfig`). Required: DB_PATH, ENC_KEY,
  TELEGRAM_TOKEN. Optional: OPENROUTER_KEY (fallback), WEB_PORT, WEB_BASE_URL,
  HEARTBEAT_DEFAULT_MIN, TAVILY_API_KEY (enables web search).
- `index.ts` — entrypoint; wires everything (adapter, dispatch, scheduler, web).
- `crypto/encryption.ts` — `initCrypto`/`encrypt`/`decrypt` (libsodium secretbox,
  loaded via `createRequire` for CJS). All secrets at rest go through this.
- `db/` — `db.ts` (openDb + `schema.sql`), and repos: `users.ts` (users + **identities**
  + allowlist), `config.ts` (per-user models + encrypted OpenRouter key), `messages.ts`,
  `jobs.ts`, `memory.ts`, `mcp.ts`, `sessions.ts`, plus `summaries` table.
- `channels/` — `adapter.ts` (channel-agnostic `ChannelAdapter` interface, carries
  `channel`), `telegram.ts` (grammY long-poll; typing indicator; **contains handler
  errors so polling never dies**).
- `agent/` — `core.ts` (`runAgentTurn`, injectable `generate`, `BASE_PERSONA`),
  `models.ts` (per-user OpenRouter models via `.chat()`), `history.ts` +
  `summarize.ts` (rolling summary), `dispatch.ts` (`handleInbound`: identity resolve,
  allowlist gate, `/login`, typing, run, summarize), `tools/` (remind, remember,
  recall, track, web_search + MCP tools via `buildToolsFor`).
- `mcp/` — `manager.ts` (per-user MCP client assembly, graceful skip on failure),
  `presets.ts` (the **Services** catalog).
- `scheduler/` — `scheduler.ts` (poll due jobs every 15s), `fire.ts` (reminders +
  follow-ups via mini agent turn), `heartbeat.ts` (proactive gate + self-reschedule),
  `quiet.ts` (tz-aware quiet hours).
- `web/` — `server.ts` (Fastify + cookie/formbody + auth preHandler), `auth.ts`
  (session), `routes/models.ts`, `routes/mcp.ts` (the **Services** screen).

## Key data model

- Users are **not** keyed by platform. `users` holds profile/prefs; `identities`
  maps `(channel, external_id)` → user. Resolve via `getUserByIdentity(db, channel,
  external_id)`; send via `getExternalId(db, userId, channel)`. Adding a platform =
  a new adapter emitting a new `channel`, **zero schema change**.
- `jobs` drive the two proactive paths: `reminder`/`followup` → `fireReminder`,
  `heartbeat` → `fireHeartbeat`. Scheduler `tick` marks done only on success (failed
  jobs stay pending for retry); a job that throws never blocks others.

## Three execution paths

1. **Reactive** — Telegram msg → `handleInbound` → allowlist gate → `runAgentTurn`
   (persona + rolling summary + recent history + tools) → reply.
2. **Scheduled** — `remind`/`track` tools write jobs; scheduler fires them via a
   cheap-model mini-turn.
3. **Heartbeat** — per-user recurring job; `fireHeartbeat` **always reschedules
   first**, then (unless quiet hours / de-allowlisted) runs a cheap-model gate that
   decides whether to proactively message.

## "Services" = MCP, dressed up

Users see **Services**, never "MCP". Web search is a **built-in default** for all
users (present whenever the instance has `TAVILY_API_KEY`). Connectable services come
from `src/mcp/presets.ts` — each preset bakes in transport/command/url and lists only
the secret(s) the user must paste. To add a service: append an `McpPreset` (stdio
presets launch via `npx -y <package>` on the host; http/sse presets take a URL +
optional auth header). The raw MCP form remains under "Advanced".

OAuth services (e.g. Google Workspace) are not yet built — they need a refresh-token
flow (loopback helper preferred, to stay firewall-only). Slack is token-based
(`xoxb-…`) and fits the preset engine.

## Gotchas learned the hard way

- **Never `git stash`** in an agent — it silently wiped uncommitted plan edits once.
  Commit doc/plan edits immediately.
- `openDb` must `mkdir -p` the DB dir (first run has no `data/`).
- OpenRouter model ids must be **current** slugs (e.g. `anthropic/claude-haiku-4.5`,
  `anthropic/claude-sonnet-5`); stale ones 404 with "No endpoints found".
- `@openrouter/ai-sdk-provider` must match `ai` v5 (use `^1.x`) with an npm override
  pinning `@ai-sdk/provider` to dedupe LanguageModelV2 types; use `openrouter.chat()`.
- `@ai-sdk/mcp` exposes `createMCPClient` + `Experimental_StdioMCPTransport` (from the
  `@ai-sdk/mcp/mcp-stdio` subpath) — there is **no** `StdioClientTransport`.
- Local vs prod bots: use the **test** bot token in local `.env`, prod token only on
  the VPS.

## Deploy

`provisioning/` has Hetzner auto-provision (`provision.sh`), `deploy.sh`,
`cloud-init.yaml`, and the systemd unit. UI is firewalled to the owner IP; Telegram
uses outbound long-poll (no public inbound needed). See `README.md` for the run order.
