# Agent-driven generic deploy — design

**Date:** 2026-07-12
**Backlog:** #13 (deploy skill), overlaps #5 (README rewrite, deploy section only)
**Status:** approved for implementation

## Goal

Make Rilo easy to self-host by pointing an AI agent at the repo. A new
self-hoster tells their coding agent "deploy this" and the agent follows a
single, host-agnostic playbook end-to-end — without rediscovering the runbook or
tripping the gotchas we hit live. As a companion, remove all
Hetzner/hcloud/`rilo.my` specifics from the adoption-facing surface so nothing
reads as tied to one host.

## Non-goals

- Not a Claude-Code-specific skill/plugin. Plain `DEPLOY.md` any agent can read.
- No host-specific commands (no Hetzner, hcloud, DigitalOcean, EC2). Firewall and
  DNS are described abstractly; the agent adapts them to the user's host.
- Not buying/booting a box. The playbook starts once a VPS with root SSH exists.
- Not the full README rewrite (#5). Only the README deploy section is touched.
- Historical docs under `docs/superpowers/` are left intact — they are an accurate
  record of what was actually run on Hetzner.

## Two workstreams

### A — new `DEPLOY.md` (repo root)

An agent-oriented deploy playbook. Portable to any coding agent; a human running
Claude Code says "deploy this" and the agent executes it.

**Boundaries.**
- Starts at: user has a fresh Ubuntu/Debian VPS with root SSH access, and the repo.
- Ends at: verified-running — bot polls, `/health` OK, owner allowlisted, UI login works.

**References, does not duplicate.** DEPLOY.md links to and invokes the repo's own
`deploy/provision.sh` and `compose.yml` rather than re-pasting their contents. Its
value-add is the ordering, the verify gates, the gotchas, and the agent contract —
things not encoded in the scripts. This keeps DEPLOY.md from rotting when scripts
change.

**Structure (top → bottom):**

1. **Agent contract** (preamble). Directives to the agent:
   - Gather all inputs from the user up front (see preflight), before touching the box.
   - Run phases in order. After each phase, run its verify command.
   - On any verify failure: STOP, report the failure to the user, do not improvise past it.
   - Never print secrets back to the user or into logs.

2. **Preflight inputs checklist.** A table the agent fills by asking the user:
   SSH target (`user@host`), Telegram bot token, OpenRouter key (optional global
   fallback), owner Telegram ID, and the public-vs-private choice (+ domain if
   public). Columns: input / where to get it / example.

3. **Phase 1 — Provision.** Run `deploy/provision.sh` on the box (installs
   Docker + compose plugin + git, clones to `/opt/personal-agent`, makes `data/`).
   *Verify:* `docker` present, repo cloned.

4. **Phase 2 — Configure.** Copy `.env.example` → `.env`, fill secrets.
   *Verify:* required keys present in `.env`.

5. **Phase 3 — Firewall** (abstract prose). Restrict inbound to the user's own IP:
   SSH (22) and web UI (`HOST_PORT`, default 8080) owner-only; outbound all
   (Telegram polling, OpenRouter, MCP). SearXNG/embedding containers are never
   published, so no rule. Described host-agnostically; agent applies it via the
   user's host firewall.
   *Verify:* UI reachable from the owner, refused from elsewhere (best-effort).

6. **Phase 4 — Up.** `docker compose up -d --build`.
   *Verify:* containers healthy, `GET /health` OK.

7. **Phase 5 — Onboard.** User messages the bot; owner is auto-owned via
   `OWNER_TELEGRAM_ID` (or `/approve`, or SQL fallback for allowlist); `/login`
   for the one-time UI link + 6-digit code.
   *Verify:* owner allowlisted, UI login succeeds.

8. **Optional — Public HTTPS + web OAuth** (clearly marked branch). DNS A record
   → box; inbound 80 + 443 open to the world (ACME); bring the stack up with the
   Caddy overlay (`docker compose -f compose.yml -f compose.caddy.yml up -d --build`);
   set `WEB_BASE_URL`, `ENABLE_WEB_OAUTH=true`, `DOMAIN`, `ACME_EMAIL`; create a
   Google Cloud OAuth client of type **Web application** with redirect URI
   `$WEB_BASE_URL/oauth/google/callback`; publish consent screen to Production.
   *Verify:* valid cert, one-click "Connect with Google" works.

9. **Gotchas** (host-agnostic, from live deploys):
   - Container runs as uid 1001; if the host `data/` dir is owned by another uid,
     chown it or the app can't write the DB.
   - Appending to `.env` without a trailing newline concatenates onto the last
     line — ensure a newline before appending.
   - On the public path, pass **both** `-f compose.yml -f compose.caddy.yml` on
     every `up`/redeploy, or the app re-publishes 8080 and Caddy stops.
   - Telegram `getUpdates` allows a single poller — stop any old process/container
     before starting a new one, or updates flap.

10. **Rollback + troubleshoot** (one-liners, not a full section — YAGNI):
    back up `data/` + `.env` before changes; revert the overlay by bringing the
    stack up without `-f compose.caddy.yml`; logs via `docker compose logs -f`;
    quick table — "bot silent" / "cert fails" / "UI unreachable" → likely cause.

### B — de-Hetzner the adoption surface

Remove every Hetzner / hcloud / `rilo.my` reference from adoption-facing files;
leave `docs/superpowers/` history untouched.

- **`README.md`** — cut the stale systemd/Hetzner runbook (it references a
  removed `deploy/hetzner/` path and the pre-migration flow). Replace with a short
  generic Docker quickstart and pointers: "Deploying with an AI agent? See
  `DEPLOY.md`." and "Full deploy reference: `deploy/README.md`." Only the deploy
  section changes; the rest of README (what Rilo is, Google connect, operating
  notes) stays.
- **`deploy/README.md`** — drop the "e.g. Hetzner" flavor and any hcloud mention;
  keep the prose generic ("any Ubuntu/Debian VPS").
- **`AGENTS.md`** — the single Hetzner reference → generic.
- **`deploy/provision.sh`** — comments referencing Hetzner → generic
  ("any Ubuntu/Debian VPS").
- **`deploy/Caddyfile` + `compose.caddy.yml`** — replace the hardcoded `rilo.my`
  domain and ACME email with env-driven `{$DOMAIN}` and `{$ACME_EMAIL}`, passed
  through from `.env` via `compose.caddy.yml`. This both removes the hardcoded
  host and makes the overlay work for any domain without editing files. Document
  `DOMAIN` / `ACME_EMAIL` in `.env.example` and DEPLOY.md's public branch.
- **`deploy/instance.local.md.example`** — the one Hetzner reference → generic
  placeholder.

## Validation

- No app tests (docs/config only).
- Grep confirms zero Hetzner/hcloud/`rilo.my` references remain outside
  `docs/superpowers/`.
- The Caddy overlay still starts with `DOMAIN`/`ACME_EMAIL` set (env substitution
  resolves; cert issues on a real domain).
- End-to-end: an agent follows DEPLOY.md on a fresh box and reaches
  verified-running. (Manual, post-implementation.)

## Files

- New: `DEPLOY.md`.
- Edited: `README.md` (deploy section), `deploy/README.md`, `AGENTS.md`,
  `deploy/provision.sh`, `deploy/Caddyfile`, `compose.caddy.yml`,
  `deploy/instance.local.md.example`, `.env.example` (`DOMAIN`/`ACME_EMAIL`).
- Untouched: everything under `docs/superpowers/`.
