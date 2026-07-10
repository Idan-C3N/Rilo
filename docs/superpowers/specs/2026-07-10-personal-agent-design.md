# Personal Agent — Design

**Date:** 2026-07-10
**Status:** Approved (design), pending implementation plan

## Summary

A personal AI agent reached over Telegram (WhatsApp later). Runs continuously on a
cheap VPS. Handles reactive chat, exact-time reminders, and an autonomous periodic
"heartbeat" self-check that decides on its own whether anything needs the user's
attention. Multi-user (isolated, all-equal). Configurable models via OpenRouter.
Supports per-user MCP servers. Small web UI for model + MCP config. Fully
auto-provisioned — user supplies keys, the setup is scripted.

## Goals

- Cheap infra (target ~$4–5/mo VPS + usage-based LLM cost).
- Configurable models per user (cheap model + strong model).
- "Works all the time": exact reminders at any horizon (10 min … 1 month) AND an
  autonomous heartbeat that proactively checks if something needs to happen.
- Per-user MCP server support (connect arbitrary MCPs).
- Web UI to configure models + MCP servers.
- Multi-user: user + wife (+ future), isolated, all-equal. Seam for shared context later.

## Non-Goals (YAGNI)

- WhatsApp at launch (channel-agnostic core; add later behind same interface).
- Admin role / role hierarchy (all users equal).
- Reminders/memory management *in the UI* (managed via chat).
- Shared/household context (leave a seam; not built now).
- Multiple provider integrations at launch (OpenRouter only; direct keys later if needed).

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Channel | Channel-agnostic core; Telegram first (long polling), WhatsApp later |
| Hosting | Single always-on Hetzner VPS, one Node process |
| Stack | TypeScript / Node; Vercel AI SDK for agent loop + model switching + MCP tools |
| Proactivity | Reminders + explicit follow-ups + autonomous heartbeat self-check |
| Multi-user | Isolated, all-equal, allowlist gate; seam for shared context later |
| UI scope | Model config + MCP management only |
| UI network gate | Hetzner firewall → user's IP (update rule if home IP changes) |
| UI identity | Magic code via bot (`/login` → one-time code → session cookie) |
| Models | OpenRouter (one key → all models) |
| Setup | Full auto-provision: user provides keys, scripts do the rest |
| DB | SQLite (one file, zero-ops) |

## Architecture

Single Node/TypeScript process on a Hetzner VPS. Internal modules:

```
┌─────────────────────────────────────────────┐
│              VPS (one Node process)           │
│  ┌──────────┐   ┌─────────────────────────┐  │
│  │ Channel  │   │      Agent Core          │  │
│  │ adapters │──▶│  (Vercel AI SDK loop,    │  │
│  │ Telegram │   │   model per user,        │  │
│  │ [WA later]│◀─│   MCP tools attached)    │  │
│  └──────────┘   └───────┬─────────┬────────┘  │
│                         │         │           │
│  ┌──────────┐   ┌───────▼───┐ ┌───▼────────┐  │
│  │ Scheduler│──▶│  Tools:   │ │ MCP manager│  │
│  │ (cron +  │   │ remind,   │ │ (per-user  │  │
│  │  jobs +  │   │ track,    │ │  servers)  │  │
│  │ heartbeat)│  │ memory    │ └────────────┘  │
│  └────┬─────┘   └───────────┘                 │
│       │         ┌───────────────────────────┐ │
│       └────────▶│  SQLite                    │ │
│  ┌───────────┐  │  (users, msgs, jobs,      │ │
│  │  Web UI   │─▶│   memory, config)         │ │
│  │ (firewall │  └───────────────────────────┘ │
│  │  +magic)  │                                 │
│  └───────────┘                                 │
└─────────────────────────────────────────────┘
```

### Components

- **Channel adapter interface** — `receive(msg)` / `send(userId, text)`. Telegram
  implementation now (long polling → no public inbound). WhatsApp later, same interface.
- **Agent core** — Vercel AI SDK agent loop. Loads the user's chosen model (via
  OpenRouter), attaches built-in tools + the user's enabled MCP tools, runs the turn.
- **Scheduler** — persists jobs in SQLite; fires exact-time reminders and the periodic
  heartbeat tick. Jobs survive restarts (reloaded on boot).
- **MCP manager** — starts/caches per-user MCP clients, exposes their tools to the agent.
- **SQLite** — single file; ample for a handful of users; zero operational overhead.
- **Web UI** — small app in the same process; model + MCP config.
- **Provisioning** — scripted VPS creation + deploy (Hetzner Cloud API + cloud-init +
  systemd + firewall).

## Data Model (SQLite)

- `users` — id, telegram_id, phone (nullable), name, quiet_hours (start/end + tz),
  heartbeat_interval_min, allowlisted (bool)
- `config` — user_id, cheap_model, strong_model, openrouter_key (encrypted), settings (json)
- `mcp_servers` — id, user_id, name, transport (stdio|http|sse), command/args or url,
  creds (encrypted json), enabled (bool)
- `messages` — id, user_id, role, content, created_at (conversation history for context)
- `jobs` — id, user_id, type (reminder|followup|heartbeat), fire_at, payload (json),
  status (pending|done|cancelled), created_at
- `memory` — id, user_id, key (nullable), text, created_at (durable facts the agent stores)
- `sessions` — id, user_id, token, expires_at (UI magic-code sessions)

All secret columns encrypted at rest (libsodium; key from a plain VPS env var —
simplest). All queries scoped by `user_id`.

## Execution Paths

### Path A — Reactive (user messages the bot)
`Telegram poll → adapter.receive → resolve user (allowlist) → send typing indicator →
load config + recent history + user MCP tools → agent loop → reply → persist messages`.
Unknown Telegram IDs → "not authorized", never reach the LLM.
While the agent loop runs, the adapter keeps Telegram's `sendChatAction("typing")`
alive (re-sent every ~4s, since it auto-expires) so the user sees "typing…" the whole
time the agent is thinking. Cleared when the reply is sent.

### Path B — Scheduled (exact-time reminders)
Agent's `remind` tool writes a `job` with `fire_at`. Scheduler polls due jobs (~30s
granularity), fires each → runs a **mini agent turn** at fire time to phrase the
reminder naturally (quality over minimal cost) → sends → marks done. Handles any
horizon (minutes → months) since it's just a timestamp in the db.

### Path C — Heartbeat (autonomous self-check — the "smart" part)
Per-user recurring tick at the user's interval (default 30 min). On tick:
1. If within quiet hours → skip.
2. **Cheap-model gate**: feed recent state (open/tracked tasks, memory, last
   conversation, current time) → structured answer "anything worth pinging about?
   yes+what / no".
3. If yes → escalate to strong model → compose message → send. Optionally schedule a
   follow-up job.
Most ticks resolve to one cheap "no" call → keeps cost low.

### Memory
Agent has `remember` / `recall` tools writing durable facts to `memory`. Memory feeds
both conversations and the heartbeat gate — this is what makes the agent feel smart and
context-aware over time.

## MCP Integration

- Per-user servers stored in `mcp_servers`. On agent-loop start, spin up the user's
  enabled MCP clients (stdio for local commands, HTTP/SSE for remote), pull their tool
  lists, hand to the Vercel AI SDK as callable tools.
- Connections cached per user; lazy-started; health-checked. If a server is down, skip
  its tools gracefully — do not fail the whole turn.
- MCP credentials encrypted at rest.

## Web UI

- Small web app (Fastify + light front end — HTMX or minimal React) in the same Node
  process. Bound to localhost; reachable only via Hetzner firewall → user's IP.
- Auth: `/login` in Telegram → bot DMs a one-time code → paste in UI → session cookie.
  Ties UI identity to messaging identity; no passwords.
- Screens:
  - **Models**: choose cheap + strong model from OpenRouter's list; set/rotate key.
  - **MCP servers**: add / remove / enable / disable; set transport + creds.

## Security & Isolation

- Allowlist gate before any LLM call; unknown IDs rejected.
- All secrets (OpenRouter key, MCP creds) encrypted at rest.
- Per-user data strictly scoped by `user_id` everywhere.
- UI never publicly exposed (firewall → IP); session tokens expire.

## Cost Control

- Cheap model for heartbeat gate + routine turns; strong model only when needed.
- Quiet hours + tunable heartbeat interval (default 30 min) reduce tick volume.
- **History: rolling summarization.** Recent messages kept verbatim; older ones
  compacted into a running summary per user (cheap model). Bounds tokens while
  preserving long-term context — feeds conversations + heartbeat.
- Target: ~$4–5/mo VPS + pay-as-you-go OpenRouter usage.

## Provisioning (auto-setup)

Script run from the dev session:
1. Hetzner Cloud API → create server (smallest tier) + SSH key + cloud-init.
2. cloud-init installs Node + dependencies.
3. Deploy app; run as systemd service (auto-restart, survives reboot).
4. Configure firewall: UI port open to user's IP only; no other public inbound
   (Telegram uses outbound long polling).
5. Seed secrets (encryption key, OpenRouter key, Telegram bot token) into env.

**User-supplied inputs:** Hetzner API token; Telegram bot token (from @BotFather);
OpenRouter key (+ credits); home IP.

## Testing Strategy

- **Unit**: scheduler fire logic, allowlist, heartbeat gate decisioning, encryption
  round-trip, tool dispatch, MCP tool assembly.
- **Integration**: fake channel adapter drives reactive / scheduled / heartbeat paths
  against in-memory SQLite. Telegram + LLM + MCP mocked — no external calls in tests.

## Resolved Decisions

1. UI front end: **HTMX** (lighter).
2. Heartbeat default interval: **30 min**.
3. Encryption key storage: **plain VPS env var** (simplest).
4. History strategy: **rolling summarization** (recent verbatim + running summary).
5. WhatsApp: **defer to later** (official Business API when built; core stays channel-agnostic).
6. Reminder phrasing: **mini agent turn at fire time** (quality preferred).
7. Telegram **typing indicator** kept alive while the agent thinks (reactive path).

---

## Addendum — post-implementation changes (2026-07-10)

The system was built and is running. Notable changes/decisions made during
implementation and live testing, superseding the above where they conflict:

- **Agent name:** Rilo.
- **Identity model (changed):** users are no longer keyed by a per-platform column.
  A normalized `identities(channel, external_id)` table maps identities → users, so a
  new messaging platform needs zero schema change. Resolve via `getUserByIdentity`;
  deliver via `getExternalId(userId, channel)`.
- **Models:** default cheap = `anthropic/claude-haiku-4.5`, strong =
  `anthropic/claude-sonnet-5` (valid OpenRouter slugs; stale `claude-3.5-*` 404).
  Provider: `@openrouter/ai-sdk-provider@^1` + npm override pinning `@ai-sdk/provider`
  to match `ai` v5; models built with `openrouter.chat()`.
- **Web search (new, default):** a native `web_search` tool (Tavily backend) is a
  **built-in default for all users** whenever the instance sets `TAVILY_API_KEY` —
  not a per-user integration. Gated absent when no key.
- **"Services" UX (reframed MCP):** users see **Services**, never "MCP". The web UI
  offers a curated catalog of one-click service presets (`src/mcp/presets.ts`) where
  the user pastes only the required secret(s); raw MCP config lives under "Advanced".
  MCP remains the under-the-hood mechanism. Planned: Google Workspace (OAuth, via a
  loopback refresh-token helper to stay firewall-only) and Slack (bot token).
- **Persona (new):** `BASE_PERSONA` gives Rilo a warm, proactive voice — replies in
  the user's language, proactively calls `remember` for durable facts/goals/contacts,
  confirms-then-offers-next-step, and reasons about sensible reminder lead times. The
  heartbeat gate is goal-aware (nudges toward stated goals like a job search).
- **Robustness fixes:** Telegram handler errors are contained so long polling never
  dies; heartbeat always reschedules before any guard; `openDb` creates its data dir;
  scheduled LLM paths re-check allowlist.
- **Testing reality:** 82 tests, `tsc` clean. Local uses a separate **test** Telegram
  bot; prod token only on the VPS.
