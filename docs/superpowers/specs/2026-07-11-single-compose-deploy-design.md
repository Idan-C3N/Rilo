# Single Docker Compose Deployment (retire systemd)

**Date:** 2026-07-11
**Issue:** infra rework (rides on #8; supersedes the #4 deploy split's systemd path)
**Status:** Approved (brainstorm complete)
**Branch:** `chore/single-compose-deploy`, based off `feat/8-search-backends` (needs its `searxng` service to relocate)

## Goal

Collapse the two deployment methods (Docker Compose + systemd) into **one root-level
Docker Compose** used identically for local Docker runs and the Hetzner VPS. Keep the
native `npm` scripts for no-Docker local dev. Make SearXNG a real always-on part of
every Docker deployment (dev and prod), honoring the "SearXNG is the default like the DB"
decision from #8.

## Decisions (resolved in brainstorm)

- **One `compose.yml` at repo root**, same artifact dev + prod. `docker compose up` starts
  **app + SearXNG** together.
- **Native dev unchanged:** `npm run dev` / `npm start` still work with no Docker. (Search
  then needs `SEARCH_BACKEND=tavily` / Google keys, or a manually-started SearXNG —
  documented, not automated.)
- **Env control:** invariant non-secrets baked into `compose.yml` `environment:`; secrets +
  per-machine values in a gitignored `.env` (`env_file`), same filename on both machines,
  different contents. `.env.example` committed.
- **Code delivery:** `git pull` on the box. Redeploy = `git pull && docker compose up -d --build`.
  Requires a git remote — **deferred**: the operator (Idan) will supply the repo later.
  Until then, this branch delivers the Compose artifacts + documents the git-pull flow;
  it does not wire a remote or run the live migration.
- **DB persistence:** **bind-mount** `./data:/app/data`. Reuses the box's existing
  `agent.db` with zero migration; the file stays directly visible/backup-able on the host.
- **systemd retired:** delete `deploy/systemd/`, `deploy/hetzner/personal-agent.service`,
  `deploy/hetzner/deploy.sh`.
- **Dockerfile + `searxng/` at repo root.** `deploy/docker/` is removed (contents moved up).

## Target layout

```
compose.yml            # app + searxng (root)
Dockerfile             # app image (moved from deploy/docker/Dockerfile)
.dockerignore          # moved/created at root
.env.example           # updated template (search + compose vars)
searxng/settings.yml   # SearXNG config (moved from deploy/docker/searxng/)
data/                  # gitignored; bind-mount target (created on first run / by provision)
deploy/
  README.md            # Compose deploy guide (dev + Hetzner), git-pull redeploy, firewall, migration
  provision.sh         # fresh box: install Docker engine + compose plugin + git, clone, mkdir data
```

Removed: `deploy/systemd/`, `deploy/hetzner/personal-agent.service`,
`deploy/hetzner/deploy.sh`, `deploy/docker/` (relocated to root).
Keep `deploy/hetzner/cloud-init.yaml` only if it can be repurposed to install Docker;
otherwise fold its intent into `provision.sh` and delete it.

## compose.yml

```yaml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    env_file: .env                 # secrets + per-machine values
    environment:                   # invariant, non-secret — identical everywhere
      SEARXNG_URL: http://searxng:8080
      WEB_PORT: "8080"
      DB_PATH: /app/data/agent.db
    ports:
      - "${HOST_PORT:-8080}:8080"  # host side overridable; container always 8080
    volumes:
      - ./data:/app/data           # bind-mount: reuses existing agent.db
    depends_on:
      - searxng
    restart: unless-stopped

  searxng:
    image: searxng/searxng:latest  # pin at OSS release (see #8 flag)
    volumes:
      - ./searxng:/etc/searxng     # JSON format enabled in settings.yml
    restart: unless-stopped        # NO published ports — internal-only, firewall intact
```

Notes:
- `env_file: .env` injects app secrets. The baked `environment:` keys win over `.env` for
  those three invariants (compose applies `environment:` after `env_file`), so an operator
  can't accidentally break them from `.env`.
- SearXNG is **not** host-published → the Hetzner firewall model (only 8080 → owner IP) is
  unchanged. The app reaches SearXNG over the compose network at `http://searxng:8080`.

## Dockerfile

Move `deploy/docker/Dockerfile` to root, adjust any `COPY`/context paths for the new root
context. Must build `better-sqlite3` (native) inside the image — confirm the base image has
the build toolchain (or use the prebuilt binary). App start command = the existing prod
start (`npm start` equivalent, no `--watch`). Add/verify `.dockerignore` excludes
`node_modules`, `data`, `.git`, `.env`.

## .env.example

Committed template covering: `ENC_KEY`, `TELEGRAM_TOKEN`, `OPENROUTER_KEY`, `WEB_BASE_URL`,
`HEARTBEAT_DEFAULT_MIN`, `GOOGLE_CLIENT_ID/SECRET`, and the #8 search block
(`SEARXNG_URL` note that Compose sets it; `GOOGLE_SEARCH_*` / `SEARCH_BACKEND` as opt-in).
`DB_PATH`/`WEB_PORT` documented as compose-managed (no need to set in `.env` for Docker).

## deploy/README.md

Rewrite around Compose:
- **Local (Docker):** `docker compose up`.
- **Local (native):** `npm install && npm run dev`; note search-backend requirement.
- **Hetzner (fresh box):** run `provision.sh` (installs Docker + compose + git, clones repo,
  makes `data/`), create `.env`, `docker compose up -d --build`.
- **Redeploy:** `ssh box 'cd /opt/personal-agent && git pull && docker compose up -d --build'`.
- **Firewall:** Hetzner API firewall (8080 → owner IP) stays; SearXNG internal-only.
- **Migration from the current systemd box** (see below).

## provision.sh

Fresh-box bootstrap (idempotent where practical):
- Install Docker Engine + `docker compose` plugin + `git`.
- `git clone <remote> /opt/personal-agent` (remote provided later).
- `mkdir -p /opt/personal-agent/data`.
- Print next steps (create `.env`, `docker compose up -d --build`).
- Does **not** manage the Hetzner firewall/server (stays via Hetzner API/console per the
  deployment memory).

## ⚠️ Live-box migration (documented; executed when the repo is provided)

Data is at risk — the box has a real `agent.db`. Reversible sequence:
1. **Back up:** `cp /opt/personal-agent/data/agent.db ~/agent.db.bak` (and download a copy).
2. Install Docker + compose + git on the box.
3. `systemctl stop personal-agent && systemctl disable personal-agent`.
4. Turn `/opt/personal-agent` into a git checkout while preserving `data/` + `.env`:
   clone fresh to a temp dir, move the existing `data/` and `.env` into it, swap directories.
5. `docker compose up -d --build`; verify: bot responds, web UI loads, a web search returns
   results (SearXNG up).
6. On success: `rm /etc/systemd/system/personal-agent.service && systemctl daemon-reload`.
7. Update the `rilo-deployment` memory (systemd → compose; new redeploy command).

## Testing / verification

This change is infra (no unit-testable app logic). Definition of Done:
- `docker compose config` validates (no YAML/interpolation errors).
- Local `docker compose up --build` brings up **both** services; app is reachable on
  `localhost:8080` (login page) and a web search returns results via the in-compose SearXNG.
- `npm run dev` still starts the app natively (no regression).
- `docker compose -f compose.yml build` succeeds (native `better-sqlite3` compiles in-image).
- Existing tests (`npm test`) unaffected — run to confirm no accidental source changes.

## Out of scope / follow-ups

- Creating the git remote + running the live migration → **when Idan supplies the repo.**
- Pinning the SearXNG image tag → tracked with #8's same flag; decide at OSS release.
- In-container dev hot-reload → explicitly not wanted (native `npm run dev` covers it).
- CI-built/registry images → not now (build-on-box via `--build`).

## Relationship to #8 / #1

- Based off `feat/8-search-backends`; it relocates that branch's `deploy/docker/compose.yml`
  + `searxng/settings.yml` to root. Merge order: `feat/8` → `main`, then this → `main`
  (fast-forwards cleanly since it contains #8's commits).
- Independent of `feat/1-google-web-oauth`. When #1's public-OAuth path is used, the operator
  sets `ENABLE_WEB_OAUTH` + a public `WEB_BASE_URL` in `.env` and fronts the app with an
  HTTPS reverse proxy — a later addition to this compose, not part of this spec.
