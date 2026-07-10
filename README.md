# personal-agent

A personal, multi-channel AI agent (Telegram now, web UI for config/login) with
reminders, follow-ups, heartbeat self-checks, and MCP tool support. Runs as a
systemd service on a cheap Hetzner VPS with SQLite storage.

## Setup

### 1. Inputs you need before you start

- **Hetzner Cloud API token** — Hetzner Console → your project → Security → API Tokens.
- **SSH key** — add your public key in Hetzner Console → Security → SSH Keys, note its name (`SSH_KEY_NAME`).
- **Telegram bot token** — create a bot via [@BotFather](https://t.me/BotFather), `/newbot`.
- **OpenRouter API key** — from [openrouter.ai](https://openrouter.ai/keys) (optional global fallback; per-user keys are preferred and set later via the UI).
- **Your own public IP** — `curl -4 ifconfig.me`, used as `OWNER_IP` (e.g. `1.2.3.4/32`) so the firewall only opens SSH/UI to you.

### 2. `.env` fields

Copy `.env.example` to `.env` and fill in:

| Field | Meaning |
|---|---|
| `DB_PATH` | SQLite file path, e.g. `./data/agent.db` |
| `ENC_KEY` | base64 of 32 random bytes: `openssl rand -base64 32` |
| `TELEGRAM_TOKEN` | from BotFather |
| `OPENROUTER_KEY` | optional global fallback key |
| `WEB_PORT` | port the web UI listens on, e.g. `8080` |
| `WEB_BASE_URL` | optional; defaults to `http://localhost:$WEB_PORT` — set to `http://<SERVER_IP>:$WEB_PORT` once you have a server IP |
| `HEARTBEAT_DEFAULT_MIN` | default heartbeat interval in minutes, e.g. `30` |

### 3. Run order

1. Add your SSH key to Hetzner Cloud (Console → Security → SSH Keys) and note its name.
2. Provision the server:
   ```bash
   HCLOUD_TOKEN=xxx OWNER_IP=1.2.3.4/32 WEB_PORT=8080 SSH_KEY_NAME=mykey ./provisioning/provision.sh
   ```
   This creates a firewall (SSH + `WEB_PORT` open to `OWNER_IP` only, all outbound allowed) and a server booted with `provisioning/cloud-init.yaml` (installs Node 22, creates the `agent` user, creates `/opt/personal-agent`). Note the printed server IP.
3. Fill in `.env` locally (see fields above), including `WEB_BASE_URL` with the server IP.
4. Copy `.env` to the server:
   ```bash
   scp .env root@<SERVER_IP>:/opt/personal-agent/.env
   ```
5. Deploy the app:
   ```bash
   SERVER_IP=<SERVER_IP> ./provisioning/deploy.sh
   ```
   This rsyncs the repo, runs `npm ci`/installs `tsx`, installs the systemd unit, and starts `personal-agent.service`.
6. Message your bot on Telegram (anything). This creates your user row, but it starts **not allowlisted** — the agent will refuse until you allowlist yourself.
7. Allowlist yourself. SSH into the server and run one SQL command against the SQLite DB:
   ```bash
   ssh root@<SERVER_IP>
   sqlite3 /opt/personal-agent/data/agent.db \
     "UPDATE users SET allowlisted = 1 WHERE id = (SELECT user_id FROM identities WHERE channel = 'telegram' ORDER BY id DESC LIMIT 1);"
   ```
   (If you have more than one user row, target yours by `identities.external_id`, i.e. your Telegram chat ID, instead of "most recent".)
8. Message the bot `/login` to get a one-time link to the web UI. Open it and enter the 6-digit code the bot sends you to finish logging in.

### Operating notes

- Logs: `ssh root@<SERVER_IP> journalctl -u personal-agent -f`
- Redeploy after code changes: re-run `SERVER_IP=<SERVER_IP> ./provisioning/deploy.sh`.
- The UI/SSH are only reachable from `OWNER_IP` per the Hetzner firewall; if your IP changes, update the firewall rule in the Hetzner console (or re-run provisioning).

## Connecting Google Workspace (Gmail + Calendar)

Rilo talks to Google with **native tools** using a per-user OAuth refresh token
(stored encrypted). One-time operator setup + a per-user connect step.

### Operator: create a Google OAuth client (once)
1. In [Google Cloud Console](https://console.cloud.google.com): create/select a project.
2. Enable the **Gmail API** and **Google Calendar API**.
3. Configure the OAuth consent screen (External; add yourself + any users as test users).
4. Create an **OAuth client ID** of type **Desktop app** → copy the client id + secret.
5. Put them in `.env`:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```
   Restart Rilo. The "Google Workspace" card now appears on the Services screen.

### Each user: connect (once)
1. From the repo, run the loopback helper:
   ```
   node --env-file=.env --import tsx scripts/google-auth.ts
   ```
2. Open the printed URL, approve access. It prints a **refresh token**.
3. In Rilo's web UI → **Services → Connect Google**, paste the refresh token.

Rilo can now search/read/send Gmail and list/create Calendar events for that user.
Disconnect anytime from the same screen.
