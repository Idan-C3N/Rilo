# personal-agent

A personal, multi-channel AI agent (Telegram now, web UI for config/login) with
reminders, follow-ups, heartbeat self-checks, and MCP tool support. Runs via
Docker Compose with SQLite storage.

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
