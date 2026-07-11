# Deploying Rilo

Rilo is a **single Node process backed by a SQLite file**, plus a bundled
[SearXNG](https://docs.searxng.org/) container for web search. Telegram uses
outbound long-polling, so there is no inbound dependency beyond the web UI port.

There is **one deployment method: Docker Compose** — the same `compose.yml` runs
locally and on a server. Native `npm` still works for no-Docker local dev.

## Local — Docker (recommended)

```bash
cp .env.example .env      # fill in secrets (see the root README)
docker compose up         # app + searxng; web UI on http://localhost:8080
```

- DB persists in `./data/agent.db` (bind-mounted, host-visible).
- Change the host port: `HOST_PORT=9000 docker compose up`.
- SearXNG runs internally at `http://searxng:8080` — no host port, no setup.

## Local — native (no Docker)

```bash
npm install
cp .env.example .env
npm run dev               # or: npm start
```

Web search needs a backend here (SearXNG isn't running): set `SEARCH_BACKEND=tavily`
or `GOOGLE_SEARCH_KEY`+`GOOGLE_SEARCH_CX` in `.env`, or start a SearXNG container
yourself and point `SEARXNG_URL` at it.

## Server (any Ubuntu/Debian VPS, e.g. Hetzner)

**One-time provision** — on a fresh box, as root:

```bash
REPO_URL=<your git remote> bash <(curl -fsSL <raw provision.sh URL>)
# or: clone the repo and run  REPO_URL=<remote> ./deploy/provision.sh
```

It installs Docker + the compose plugin + git, clones to `/opt/personal-agent`,
and makes `data/`. Then:

```bash
cd /opt/personal-agent
cp .env.example .env      # fill in secrets
docker compose up -d --build
```

**Redeploy** after pushing code:

```bash
ssh <box> 'cd /opt/personal-agent && git pull && docker compose up -d --build'
```

### Locking it down (firewall)

Rilo expects to sit behind a host firewall. On Hetzner, create a Cloud Firewall
(console or API) restricting inbound to your own IP:

- **TCP 22 (SSH)** — source: your IP only
- **TCP 8080 (web UI)** — source: your IP only
- **Outbound** — allow all (Telegram polling, OpenRouter, MCP servers)

SearXNG is never published to the host, so it needs no firewall rule.

> If you expose the web UI publicly (e.g. for `ENABLE_WEB_OAUTH` — real Google
> OAuth), front the app with an HTTPS reverse proxy and set `WEB_BASE_URL` to the
> public URL. That is a deliberate departure from the firewall-only model.

---

Whatever the target, you provide the same secrets via `.env` (see `.env.example`
and the root README). Invariant, non-secret settings (`SEARXNG_URL`, `WEB_PORT`,
`DB_PATH`) are baked into `compose.yml` and don't belong in `.env`.
