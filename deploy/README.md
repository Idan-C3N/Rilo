# Deploying Rilo

Rilo is a **single Node process backed by a SQLite file**, plus a bundled
[SearXNG](https://docs.searxng.org/) container for web search and a bundled
**embedding** container (HuggingFace TEI, `multilingual-e5-small`) that powers
semantic memory recall. Like SearXNG, the embedding server is internal-only and
needs no host port or firewall rule. Telegram uses outbound long-polling, so
there is no inbound dependency beyond the web UI port.

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

## Server (any Ubuntu/Debian VPS)

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

Rilo expects to sit behind a host firewall. At your VPS provider, create a
firewall (console or API) restricting inbound to your own IP:

- **TCP 22 (SSH)** — source: your IP only
- **TCP 8080 (web UI)** — source: your IP only
- **Outbound** — allow all (Telegram polling, OpenRouter, MCP servers)

SearXNG is never published to the host, so it needs no firewall rule.

## Optional: one-click "Connect with Google" (public OAuth)

By default Rilo connects Google via the firewall-friendly loopback/paste flow
(`scripts/google-auth.ts`) and needs no inbound access. If instead you expose
Rilo on a **public HTTPS URL** and want a one-click **Connect with Google**
button, set `ENABLE_WEB_OAUTH=true`. This requires:

- A public, HTTPS `WEB_BASE_URL` (terminate TLS at a reverse proxy in front of
  the app — Rilo itself serves plain HTTP). A ready-made **Caddy** overlay ships
  in the repo: `compose.caddy.yml` + `deploy/Caddyfile` (auto Let's Encrypt).
- A Google Cloud OAuth client of type **Web application** whose authorized
  redirect URI is `$WEB_BASE_URL/oauth/google/callback`.
- Publish the OAuth consent screen to **Production** (unverified is fine for a
  few users — they click through the "unverified app" warning). In *Testing*
  mode Google expires refresh tokens after 7 days, which breaks the connection.

Leave `ENABLE_WEB_OAUTH` unset (default `false`) to keep the loopback/paste flow.

### Public deploy with the Caddy overlay

Prereqs: a DNS A record for your domain → the box, and inbound **80 + 443 open
to the world** (Let's Encrypt ACME) — add these to your host firewall alongside
the SSH/8080 owner-only rules above. Then set in `.env`:

```
WEB_BASE_URL=https://<your-domain>
ENABLE_WEB_OAUTH=true
```

and bring the stack up **with the overlay** (Caddy on 80/443, app internal-only):

```bash
cd /opt/personal-agent && git pull
docker compose -f compose.yml -f compose.caddy.yml up -d --build
```

Use the same two `-f` files on every redeploy, or the app re-publishes 8080 and
Caddy stops. The overlay reads `DOMAIN` (and optional `ACME_EMAIL`) from `.env` —
no file edits needed.

---

Whatever the target, you provide the same secrets via `.env` (see `.env.example`
and the root README). Invariant, non-secret settings (`SEARXNG_URL`, `WEB_PORT`,
`DB_PATH`) are baked into `compose.yml` and don't belong in `.env`.
