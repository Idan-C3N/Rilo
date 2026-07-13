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
ssh <box> 'cd /opt/personal-agent && docker compose ps && curl -fsS http://localhost:8080/login'
```
Expected: containers show `running` (healthy) and `/login` returns 200 (a public
route). If the app can't write the DB, see the uid-1001 gotcha below.

## Phase 5 — Onboard the owner

1. Ask the user to message their bot anything on Telegram.
2. With `OWNER_TELEGRAM_ID` set, that user is auto-owned and allowlisted on boot.
   (If it wasn't set: the owner can `/approve` from the Pending list, or as a last
   resort allowlist via SQL — see below.)
3. Ask the user to send `/login` to the bot, open the one-time link, and enter the
   6-digit code the bot sends.

**SQL fallback** (only if auto-owner didn't apply):
```bash
# SSH into the box first, then from /opt/personal-agent:
docker compose exec -T app node -e 'const db=require("better-sqlite3")("/app/data/agent.db"); db.prepare("UPDATE users SET allowlisted = 1 WHERE id = (SELECT user_id FROM identities WHERE channel = '"'"'telegram'"'"' ORDER BY id DESC LIMIT 1)").run(); console.log("allowlisted")'
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
curl -fsSI https://<domain>/login
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
