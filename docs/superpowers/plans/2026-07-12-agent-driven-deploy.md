# Agent-Driven Generic Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a portable, host-agnostic `DEPLOY.md` agent playbook and scrub Hetzner/hcloud/`rilo.my` from the adoption-facing surface, so any coding agent can stand Rilo up on any VPS.

**Architecture:** Docs + config only — no application code changes. `DEPLOY.md` references the repo's own `deploy/provision.sh` / `compose.yml` rather than duplicating them; its value is ordering, verify gates, gotchas, and an agent contract. The Caddy overlay becomes env-driven (`{$DOMAIN}`) so the public path works for any domain without editing files.

**Tech Stack:** Markdown, Docker Compose, Caddy (env substitution).

## Global Constraints

- **Isolation:** All work happens in a dedicated git worktree (another agent is active in the main workspace). Set up in Task 0; never edit files in the primary checkout.
- **No host-specific commands** anywhere in adoption-facing files: no "Hetzner", "hcloud", "rilo.my". Firewall/DNS described abstractly.
- **Leave `docs/superpowers/` history untouched** — it is an accurate record of what was run.
- **Reference, don't duplicate:** `DEPLOY.md` links to `deploy/provision.sh` and `compose.yml`; it does not re-paste their contents.
- **Never echo secrets:** the agent contract in `DEPLOY.md` must forbid printing secrets back to the user or into logs.
- **Verification instead of unit tests:** this is a docs/config change; each task's "test" is a grep or `docker compose config` gate, not a test runner.

---

### Task 0: Set up isolated worktree

**Files:** none edited — environment setup only.

**Interfaces:**
- Produces: a worktree at `../personal-agent-deploy` on branch `agent-driven-deploy`, where all later tasks run.

- [ ] **Step 1: Create the worktree and branch from main**

Run:
```bash
cd /Users/idan/programming/personal/personal-agent
git worktree add -b agent-driven-deploy ../personal-agent-deploy main
```
Expected: `Preparing worktree (new branch 'agent-driven-deploy')` and a checkout at `../personal-agent-deploy`.

- [ ] **Step 2: Verify the worktree is clean and on the new branch**

Run:
```bash
cd ../personal-agent-deploy && git status -sb && git worktree list
```
Expected: `## agent-driven-deploy`, clean tree, and the new worktree listed. **All subsequent tasks run from `../personal-agent-deploy`.**

---

### Task 1: Env-drive the Caddy overlay

Make the public TLS overlay work for any domain without editing files. Only `rilo.my` is hardcoded (the email is already `{$ACME_EMAIL}`), so the domain becomes `{$DOMAIN}`, compose passes `DOMAIN`/`ACME_EMAIL` into the Caddy container, and `.env.example` documents both.

**Files:**
- Modify: `deploy/Caddyfile`
- Modify: `compose.caddy.yml`
- Modify: `.env.example`

**Interfaces:**
- Produces: `DOMAIN` and `ACME_EMAIL` env vars consumed by the Caddy overlay; referenced by DEPLOY.md's public branch (Task 4).

- [ ] **Step 1: Rewrite `deploy/Caddyfile` to be domain-agnostic**

Replace the entire file with:
```
# Caddy config for the public deployment. Used only by compose.caddy.yml.
# The site address and ACME email come from the environment (DOMAIN / ACME_EMAIL
# in .env, passed through by compose.caddy.yml). Caddy auto-provisions and renews
# a Let's Encrypt cert for $DOMAIN and reverse-proxies to the app container on the
# internal compose network (service name `app`).
#
# ACME registers anonymously when ACME_EMAIL is empty (fine for Let's Encrypt).
# Set ACME_EMAIL in .env to receive cert-expiry notices.

{
	email {$ACME_EMAIL}
}

{$DOMAIN} {
	reverse_proxy app:8080
}
```

- [ ] **Step 2: Pass `DOMAIN`/`ACME_EMAIL` into the Caddy container in `compose.caddy.yml`**

Replace the file's top comment and the `caddy:` service block so the service has an `environment:` key. New file content:
```yaml
# TLS reverse-proxy overlay for the PUBLIC deployment.
# Server-only — layer it over compose.yml:
#   DOMAIN=<your-domain> docker compose -f compose.yml -f compose.caddy.yml up -d --build
#
# Caddy terminates HTTPS on 80/443 (auto Let's Encrypt) and proxies to the app
# container on its internal port 8080. Requires: a DNS A record <DOMAIN> -> host,
# and inbound 80+443 open to the world (ACME). Plain local `docker compose up`
# (compose.yml alone) is unaffected — no Caddy, app still on localhost:8080.
services:
  caddy:
    image: caddy:2
    ports:
      - "80:80"
      - "443:443"
    environment:
      - DOMAIN=${DOMAIN}
      - ACME_EMAIL=${ACME_EMAIL}
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data       # persisted certs — survives redeploys, avoids ACME rate limits
      - caddy_config:/config
    depends_on:
      - app
    restart: unless-stopped

  # Fronted by Caddy, the app needs no host port — keep it off the public
  # interface entirely (defense in depth on top of the firewall).
  app:
    ports: !reset []

volumes:
  caddy_data:
  caddy_config:
```

- [ ] **Step 3: Document `DOMAIN`/`ACME_EMAIL` in `.env.example`**

In `.env.example`, find the `ENABLE_WEB_OAUTH=` block (under "Google Workspace"). Immediately **after** that block, append:
```
# --- Public HTTPS (Caddy overlay), optional ---
# Only for the public deploy path (compose.caddy.yml). Leave unset for firewalled installs.
DOMAIN=          # your domain, e.g. agent.example.com — Caddy issues a Let's Encrypt cert for it
ACME_EMAIL=      # optional; email for Let's Encrypt cert-expiry notices (blank = anonymous)
```

- [ ] **Step 4: Verify the overlay resolves with a domain set**

Run:
```bash
DOMAIN=example.com ACME_EMAIL= docker compose -f compose.yml -f compose.caddy.yml config | grep -A6 'caddy:'
```
Expected: valid merged config printed (no interpolation errors), Caddy service shows `DOMAIN=example.com` in its environment.

- [ ] **Step 5: Confirm no `rilo.my` remains in the overlay files**

Run:
```bash
grep -rniI "rilo\.my" deploy/Caddyfile compose.caddy.yml
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add deploy/Caddyfile compose.caddy.yml .env.example
git commit -m "feat(deploy): env-drive the Caddy overlay (DOMAIN/ACME_EMAIL)"
```

---

### Task 2: De-Hetzner scripts and small docs

Scrub the remaining Hetzner/hcloud references and fix the two stale `deploy/hetzner/` mentions (that directory no longer exists).

**Files:**
- Modify: `deploy/provision.sh` (lines 13-14)
- Modify: `AGENTS.md` (Deploy section, ~lines 110-114)
- Modify: `deploy/instance.local.md.example` (line 7)
- Modify: `deploy/README.md` (drop "e.g. Hetzner" flavor)

- [ ] **Step 1: Generic-ize the `deploy/provision.sh` comment**

In `deploy/provision.sh`, replace:
```bash
# The Hetzner firewall (SSH + 8080 restricted to your IP) is managed in the
# Hetzner console/API, not here — see deploy/README.md.
```
with:
```bash
# The host firewall (SSH + 8080 restricted to your IP) is managed at your VPS
# provider (console/API), not here — see deploy/README.md.
```

- [ ] **Step 2: Rewrite the `AGENTS.md` Deploy section**

In `AGENTS.md`, replace:
```
`deploy/hetzner/` has Hetzner auto-provision (`provision.sh`), `deploy.sh`,
`cloud-init.yaml`, and the systemd unit. UI is firewalled to the owner IP; Telegram
uses outbound long-poll (no public inbound needed). See `README.md` for the run order.
```
with:
```
`deploy/provision.sh` bootstraps any Ubuntu/Debian VPS (Docker + compose + git,
clones to `/opt/personal-agent`); the stack runs via `compose.yml`. UI is firewalled
to the owner IP; Telegram uses outbound long-poll (no public inbound needed). See
`DEPLOY.md` for the agent-driven runbook and `deploy/README.md` for the reference.
```

- [ ] **Step 3: Generic-ize `deploy/instance.local.md.example`**

In `deploy/instance.local.md.example`, replace the redeploy + logs lines:
```
- Redeploy: `SERVER_IP=<SERVER_IP> ./deploy/hetzner/deploy.sh`
- Logs: `ssh root@<SERVER_IP> journalctl -u personal-agent -f`
```
with:
```
- Redeploy: `ssh root@<SERVER_IP> 'cd /opt/personal-agent && git pull && docker compose up -d --build'`
- Logs: `ssh root@<SERVER_IP> 'cd /opt/personal-agent && docker compose logs -f'`
```

- [ ] **Step 4: Drop the Hetzner flavor in `deploy/README.md`**

In `deploy/README.md`, change the server section heading:
```
## Server (any Ubuntu/Debian VPS, e.g. Hetzner)
```
to:
```
## Server (any Ubuntu/Debian VPS)
```
Then, in the "Locking it down (firewall)" paragraph, replace:
```
Rilo expects to sit behind a host firewall. On Hetzner, create a Cloud Firewall
(console or API) restricting inbound to your own IP:
```
with:
```
Rilo expects to sit behind a host firewall. At your VPS provider, create a
firewall (console or API) restricting inbound to your own IP:
```
And in the "Public deploy with the Caddy overlay" section, replace:
```
Prereqs: a DNS A record for your domain → the box, and inbound **80 + 443 open
to the world** (Let's Encrypt ACME) — add these to the Hetzner firewall
alongside the SSH/8080 owner-only rules above. Then set in `.env`:
```
with:
```
Prereqs: a DNS A record for your domain → the box, and inbound **80 + 443 open
to the world** (Let's Encrypt ACME) — add these to your host firewall alongside
the SSH/8080 owner-only rules above. Then set in `.env`:
```
Also replace the trailing Caddyfile note:
```
Use the same two `-f` files on every redeploy, or the app re-publishes 8080 and
Caddy stops. `deploy/Caddyfile` hardcodes the domain + ACME email — edit it for
your own host.
```
with:
```
Use the same two `-f` files on every redeploy, or the app re-publishes 8080 and
Caddy stops. The overlay reads `DOMAIN` (and optional `ACME_EMAIL`) from `.env` —
no file edits needed.
```

- [ ] **Step 5: Verify no Hetzner/hcloud remains in these files**

Run:
```bash
grep -rniI "hetzner\|hcloud" deploy/provision.sh AGENTS.md deploy/instance.local.md.example deploy/README.md
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add deploy/provision.sh AGENTS.md deploy/instance.local.md.example deploy/README.md
git commit -m "docs(deploy): scrub Hetzner/hcloud specifics from scripts and reference docs"
```

---

### Task 3: Rewrite the README deploy section

The README `## Setup` section (lines 7-64) is the stale pre-migration systemd/Hetzner runbook — it references a removed `deploy/hetzner/` path. Replace it with a short generic quickstart plus pointers. Everything from `## Connecting Google Workspace` onward stays unchanged.

**Files:**
- Modify: `README.md` (replace `## Setup` through the end of `### Operating notes`, i.e. everything above `## Connecting Google Workspace`)

- [ ] **Step 1: Replace the Setup section**

In `README.md`, delete everything from the line `## Setup` up to (but not including) `## Connecting Google Workspace (Gmail + Calendar)`, and insert in its place:

```markdown
## Setup

Rilo runs as a single Node process backed by a SQLite file, plus bundled SearXNG
(web search) and embedding (semantic memory) containers — all via Docker Compose.

### What you need first

| Input | Where to get it |
|---|---|
| **Telegram bot token** | Create a bot via [@BotFather](https://t.me/BotFather) → `/newbot`. |
| **Your Telegram numeric ID** | Message [@userinfobot](https://t.me/userinfobot); this becomes `OWNER_TELEGRAM_ID` (auto-owned + allowlisted on boot). |
| **OpenRouter key** *(optional)* | [openrouter.ai/keys](https://openrouter.ai/keys) — a global fallback; per-user keys are preferred and set later in the UI. |
| **A VPS** *(for server deploy)* | Any Ubuntu/Debian box with root SSH. |

### Run it locally

```bash
cp .env.example .env      # fill in TELEGRAM_TOKEN, ENC_KEY, OWNER_TELEGRAM_ID
docker compose up         # web UI on http://localhost:8080
```

`ENC_KEY` is `openssl rand -base64 32`. The DB persists in `./data/agent.db`.

### Deploy to a server

**Deploying with an AI agent?** Point it at [`DEPLOY.md`](DEPLOY.md) — a host-agnostic,
step-by-step runbook it can follow end-to-end.

**Doing it yourself?** See [`deploy/README.md`](deploy/README.md) for the full
Docker Compose reference (provision, firewall, and the optional public HTTPS +
"Connect with Google" path).

After the app is up: message your bot, approve yourself as owner (auto if
`OWNER_TELEGRAM_ID` is set), then `/login` for a one-time link to the web UI.

### Operating notes

- Logs: `ssh <box> 'cd /opt/personal-agent && docker compose logs -f'`
- Redeploy after code changes: `ssh <box> 'cd /opt/personal-agent && git pull && docker compose up -d --build'`
- Keep the UI/SSH firewalled to your own IP; if your IP changes, update the host firewall rule at your VPS provider.

```

- [ ] **Step 2: Verify no Hetzner/hcloud/stale path remains in README**

Run:
```bash
grep -niI "hetzner\|hcloud\|deploy/hetzner\|HCLOUD_TOKEN\|systemd\|rilo\.my" README.md
```
Expected: no output.

- [ ] **Step 3: Verify the pointers and structure are intact**

Run:
```bash
grep -n "DEPLOY.md\|deploy/README.md\|## Connecting Google Workspace" README.md
```
Expected: the `DEPLOY.md` and `deploy/README.md` pointers appear, and the `## Connecting Google Workspace` heading still follows the Setup section.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: replace stale README setup runbook with generic quickstart + DEPLOY.md pointer"
```

---

### Task 4: Write `DEPLOY.md`

The agent playbook. Host-agnostic, private core + optional public branch, preflight → gated phases. References `deploy/provision.sh` and `compose.yml` — does not duplicate them.

**Files:**
- Create: `DEPLOY.md`

**Interfaces:**
- Consumes: `DOMAIN`/`ACME_EMAIL` (Task 1), the generic firewall prose (Task 2), the README pointer (Task 3).

- [ ] **Step 1: Create `DEPLOY.md` with the full playbook**

Create `DEPLOY.md` with exactly this content:

````markdown
# Deploying Rilo with an AI agent

This is a runbook for an AI coding agent to deploy Rilo end-to-end. If you're a
human, you can follow it too, or use the quickstart in [`README.md`](README.md)
and the reference in [`deploy/README.md`](deploy/README.md).

## Agent contract — read first

You are deploying Rilo for a user, onto **their** server. Follow these rules:

1. **Gather every input up front** (see Preflight) before running anything on the box.
2. **Run the phases in order.** After each phase, run its **Verify** step.
3. **On any verify failure: STOP, report the failure to the user, and wait.** Do
   not improvise past a failed gate or invent workarounds.
4. **Never print secrets** (tokens, keys, `ENC_KEY`) back to the user or into logs.
   Write them straight into `.env` on the server.
5. This runbook is **host-agnostic**. Where it says "your host firewall" or "DNS",
   apply it using whatever the user's VPS provider offers — do not assume a vendor.

**Boundary:** this runbook starts once the user has a fresh Ubuntu/Debian VPS with
root SSH access and this repo. It ends at *verified-running*: the bot polls, the
web UI answers, and the owner is allowlisted and logged in.

## Preflight — gather inputs

Ask the user for these and hold them. Do not proceed until the required ones are known.

| Input | Required | Where to get it |
|---|---|---|
| SSH target (`user@host`) | yes | The user's VPS with root SSH. |
| Telegram bot token | yes | [@BotFather](https://t.me/BotFather) → `/newbot`. |
| Owner Telegram numeric ID | yes | [@userinfobot](https://t.me/userinfobot). Becomes `OWNER_TELEGRAM_ID`. |
| OpenRouter key | no | [openrouter.ai/keys](https://openrouter.ai/keys). Optional global fallback. |
| Public deploy? (+ domain) | no | Only if the user wants a public HTTPS URL and one-click "Connect with Google". Needs a domain with DNS you control. Default is **private**. |

Also generate `ENC_KEY` when you write `.env`: `openssl rand -base64 32`.

## Phase 1 — Provision the box

Bootstrap Docker + compose + git and clone the repo. Run on the server:

```bash
REPO_URL=<repo git remote> bash <(curl -fsSL <raw provision.sh URL>)
# or, if the repo is already on the box: REPO_URL=<remote> ./deploy/provision.sh
```

This clones to `/opt/personal-agent` and creates `data/`. See
[`deploy/provision.sh`](deploy/provision.sh) for what it does.

**Verify:**
```bash
ssh <box> 'docker --version && test -d /opt/personal-agent/.git && echo OK'
```
Expected: Docker version prints and `OK`.

## Phase 2 — Configure `.env`

```bash
ssh <box> 'cd /opt/personal-agent && test -f .env || cp .env.example .env'
```
Then set (append with a **leading newline** — see Gotchas): `TELEGRAM_TOKEN`,
`ENC_KEY`, `OWNER_TELEGRAM_ID`, and optionally `OPENROUTER_KEY`.

**Verify:**
```bash
ssh <box> 'cd /opt/personal-agent && grep -q "^TELEGRAM_TOKEN=.\+" .env && grep -q "^ENC_KEY=.\+" .env && grep -q "^OWNER_TELEGRAM_ID=.\+" .env && echo OK'
```
Expected: `OK`.

## Phase 3 — Firewall

Rilo expects to sit behind a host firewall. Using the user's VPS provider,
restrict **inbound** to the user's own IP:

- **TCP 22 (SSH)** — source: the user's IP only.
- **TCP 8080 (web UI)** — source: the user's IP only.
- **Outbound** — allow all (Telegram polling, OpenRouter, MCP servers).

SearXNG and the embedding container are never published to the host — no rule needed.
(The public path in the optional section opens 80/443 additionally.)

**Verify:** confirm with the user that the UI port is reachable from their machine
and refused elsewhere. This is host-specific; ask the user to confirm the rules
are applied.

## Phase 4 — Bring the stack up

```bash
ssh <box> 'cd /opt/personal-agent && docker compose up -d --build'
```

**Verify:**
```bash
ssh <box> 'cd /opt/personal-agent && docker compose ps && curl -fsS http://localhost:8080/health'
```
Expected: containers `running`/healthy and `/health` returns OK. If the app can't
write the DB, see the uid-1001 gotcha below.

## Phase 5 — Onboard the owner

1. Ask the user to message their bot anything on Telegram.
2. With `OWNER_TELEGRAM_ID` set, that user is auto-owned and allowlisted on boot.
   (If it wasn't set: the owner can `/approve` from the Pending list, or as a last
   resort allowlist via SQL — see below.)
3. Ask the user to send `/login` to the bot, open the one-time link, and enter the
   6-digit code the bot sends.

**SQL fallback** (only if auto-owner didn't apply):
```bash
ssh <box> "cd /opt/personal-agent && docker compose exec app sqlite3 /app/data/agent.db \
  \"UPDATE users SET allowlisted = 1 WHERE id = (SELECT user_id FROM identities WHERE channel = 'telegram' ORDER BY id DESC LIMIT 1);\""
```

**Verify:** the user confirms the bot responds to a normal message and the web UI
login succeeds.

---

## Optional — Public HTTPS + "Connect with Google"

Do this **only** if the user opted into a public deploy in Preflight. It adds a
public domain, TLS via Caddy, and the one-click Google OAuth button.

1. **DNS:** create an A record for the user's domain → the box's IP.
2. **Firewall:** additionally open inbound **80 + 443 to the world** (Let's Encrypt ACME).
3. **Env:** set in `/opt/personal-agent/.env`:
   ```
   WEB_BASE_URL=https://<domain>
   ENABLE_WEB_OAUTH=true
   DOMAIN=<domain>
   ACME_EMAIL=<email>   # optional; blank = anonymous ACME registration
   ```
4. **Google OAuth client:** in Google Cloud Console, create an OAuth client of type
   **Web application** with redirect URI `https://<domain>/oauth/google/callback`;
   put the id/secret in `.env` as `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; publish
   the consent screen to **Production** (Testing mode expires refresh tokens after 7 days).
5. **Up with the overlay** (use **both** `-f` files every time):
   ```bash
   ssh <box> 'cd /opt/personal-agent && git pull && docker compose -f compose.yml -f compose.caddy.yml up -d --build'
   ```

**Verify:**
```bash
curl -fsSI https://<domain>/health
```
Expected: a valid TLS cert (no warning) and a 200. Confirm the "Connect with Google"
button appears on the Services screen.

---

## Gotchas (hit on real deploys)

- **DB write fails / permission denied:** the app container runs as uid 1001. If
  the host `data/` dir is owned by another uid, chown it:
  `ssh <box> 'chown -R 1001:1001 /opt/personal-agent/data'`.
- **`.env` appends onto the wrong line:** appending without a trailing newline
  concatenates onto the last line. Ensure a newline before appending a var.
- **Public path drops back to 8080:** you must pass **both** `-f compose.yml -f
  compose.caddy.yml` on every `up`/redeploy, or the app re-publishes 8080 and Caddy
  stops fronting it.
- **Bot updates flap:** Telegram `getUpdates` allows a single poller. Stop any old
  process/container before starting a new one.

## Rollback & troubleshoot

- **Back up before changes:** `ssh <box> 'cd /opt/personal-agent && cp -r data data.bak && cp .env .env.bak'`.
- **Undo the public overlay:** bring the stack up without `-f compose.caddy.yml`
  (plain `docker compose up -d --build`) to return to the firewalled 8080 UI.
- **Logs:** `ssh <box> 'cd /opt/personal-agent && docker compose logs -f'`.

| Symptom | Likely cause |
|---|---|
| Bot silent | Two pollers running (old process not stopped), or bad `TELEGRAM_TOKEN`. |
| Cert fails | DNS A record not propagated, or 80/443 not open to the world. |
| UI unreachable | Firewall rule missing your IP, or container not healthy (`docker compose ps`). |
| App won't write DB | `data/` owned by wrong uid — chown to 1001 (see Gotchas). |
````

- [ ] **Step 2: Verify `DEPLOY.md` is host-agnostic and references (not duplicates) scripts**

Run:
```bash
grep -niI "hetzner\|hcloud\|rilo\.my" DEPLOY.md
grep -c "deploy/provision.sh\|compose.yml" DEPLOY.md
```
Expected: first grep no output; second prints a nonzero count (references present).

- [ ] **Step 3: Verify DEPLOY.md does not paste script bodies**

Run:
```bash
grep -niI "apt-get install\|useradd\|systemctl" DEPLOY.md
```
Expected: no output (provisioning internals stay in `deploy/provision.sh`).

- [ ] **Step 4: Commit**

```bash
git add DEPLOY.md
git commit -m "docs: add DEPLOY.md — host-agnostic agent-driven deploy playbook"
```

---

### Task 5: Final repo-wide gate

Confirm the whole adoption surface is clean and nothing outside `docs/superpowers/` still names a host.

**Files:** none edited — verification only.

- [ ] **Step 1: Repo-wide grep excluding history and node_modules**

Run:
```bash
grep -rniI "hetzner\|hcloud" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=superpowers . || echo "CLEAN"
```
Expected: `CLEAN` (only `docs/superpowers/` history may still contain refs, and it's excluded).

- [ ] **Step 2: Confirm `rilo.my` only survives in history**

Run:
```bash
grep -rniI "rilo\.my" --exclude-dir=node_modules --exclude-dir=.git . | grep -v "docs/superpowers/" || echo "CLEAN"
```
Expected: `CLEAN`.

- [ ] **Step 3: Confirm the compose stack still validates (both plain and overlay)**

Run:
```bash
docker compose config >/dev/null && DOMAIN=example.com docker compose -f compose.yml -f compose.caddy.yml config >/dev/null && echo OK
```
Expected: `OK`.

---

## Handoff after implementation

Work is on branch `agent-driven-deploy` in the `../personal-agent-deploy` worktree.
When done and reviewed, open a PR (or merge to `main`), then remove the worktree:
```bash
git worktree remove ../personal-agent-deploy
```
Validate for real by having an agent follow `DEPLOY.md` on a fresh box (manual, post-merge).
