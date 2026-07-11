# Repo Split for Open-Sourcing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the repo so it can be published open-source — deploy tooling reframed as options under `deploy/` (Docker headline), the author's private instance details extracted to gitignored files, the live IP scrubbed from git history, MIT license added.

**Architecture:** `provisioning/` becomes `deploy/{docker,hetzner,systemd}/` plus a framing README. Private runtime values move to a gitignored `instance.local.md` (committed `.example` template) — one public repo, no second repo/branch. History is rewritten once with `git-filter-repo` to purge the live IP, then pushed to a fresh public remote.

**Tech Stack:** Node 22+, TypeScript/ESM run via `tsx` (no compile step), `better-sqlite3` (native), Docker + docker compose, systemd, `git-filter-repo`.

## Global Constraints

- **Node 22+**, ESM, run via `tsx` — `tsx` is a **runtime** dependency; there is **no build/compile step**. Entrypoint: `node --import tsx src/index.ts`.
- **`better-sqlite3` is a native module** — Docker image needs a C++ toolchain available at `npm ci` time.
- **Never bake secrets into a Docker image layer** — no `COPY .env`; env comes in at run time via compose `env_file` / `environment`.
- **License: MIT**, holder "Idan Cohen", year 2026.
- **Keep the app suite green** after every task: `npm test` and `npx tsc --noEmit` must pass (AGENTS.md gate). Deploy files are not imported by `src/`, so they can't break types — but run the gate anyway before each commit.
- All work happens on branch **`oss-prep`** (already checked out). The one-time history scrub + publish is the final task and is destructive — it has its own backup step.

---

### Task 1: Move Hetzner scripts to `deploy/hetzner/` and fix internal path refs

Moves the four provisioning files verbatim and repairs the two hardcoded intra-script paths plus prose references. No app code changes.

**Files:**
- Move: `provisioning/provision.sh` → `deploy/hetzner/provision.sh`
- Move: `provisioning/deploy.sh` → `deploy/hetzner/deploy.sh`
- Move: `provisioning/cloud-init.yaml` → `deploy/hetzner/cloud-init.yaml`
- Move: `provisioning/personal-agent.service` → `deploy/hetzner/personal-agent.service`
- Modify: `deploy/hetzner/provision.sh` (cloud-init path + usage/echo lines)
- Modify: `deploy/hetzner/deploy.sh` (service copy path + usage line)
- Modify: `README.md`, `AGENTS.md` (prose `provisioning/` → `deploy/hetzner/`)

**Interfaces:**
- Produces: the directory `deploy/hetzner/` containing the four scripts, invoked as `./deploy/hetzner/provision.sh` and `SERVER_IP=x ./deploy/hetzner/deploy.sh`. Task 4 (deploy/README) and Task 3 (systemd) reference this path.

- [ ] **Step 1: Move the four files with git**

```bash
mkdir -p deploy/hetzner
git mv provisioning/provision.sh        deploy/hetzner/provision.sh
git mv provisioning/deploy.sh           deploy/hetzner/deploy.sh
git mv provisioning/cloud-init.yaml     deploy/hetzner/cloud-init.yaml
git mv provisioning/personal-agent.service deploy/hetzner/personal-agent.service
rmdir provisioning 2>/dev/null || true
```

- [ ] **Step 2: Fix the hardcoded cloud-init path inside `provision.sh`**

In `deploy/hetzner/provision.sh`, the server-create step reads the cloud-init file by literal path. Change every `provisioning/` to `deploy/hetzner/`:

- Usage comment line: `#   HCLOUD_TOKEN=xxx OWNER_IP=1.2.3.4/32 WEB_PORT=8080 SSH_KEY_NAME=mykey ./deploy/hetzner/provision.sh`
- The `user_data` line — change:
  ```
  "user_data": $(python3 -c 'import json,sys;print(json.dumps(open("provisioning/cloud-init.yaml").read()))')
  ```
  to:
  ```
  "user_data": $(python3 -c 'import json,sys;print(json.dumps(open("deploy/hetzner/cloud-init.yaml").read()))')
  ```
- The two trailing echo lines:
  ```
  echo "  2) SERVER_IP=<IP> ./deploy/hetzner/deploy.sh"
  ```

- [ ] **Step 3: Fix the service-copy path inside `deploy.sh`**

In `deploy/hetzner/deploy.sh`:
- Usage comment: `# Usage: SERVER_IP=x.x.x.x ./deploy/hetzner/deploy.sh`
- Inside the remote heredoc, change:
  ```
  cp provisioning/personal-agent.service /etc/systemd/system/personal-agent.service
  ```
  to:
  ```
  cp deploy/hetzner/personal-agent.service /etc/systemd/system/personal-agent.service
  ```

- [ ] **Step 4: Update prose references in README.md and AGENTS.md**

Replace `provisioning/` with `deploy/hetzner/` in both files. Find them:
```bash
grep -n "provisioning/" README.md AGENTS.md
```
Update each hit (README run-order commands, README operating notes, AGENTS.md "Deploy" section). Do **not** touch `docs/superpowers/plans/2026-07-10-personal-agent.md` — it is dated historical record.

- [ ] **Step 5: Verify no stale refs and directory is gone**

```bash
test ! -d provisioning && echo "provisioning gone"
grep -rn "provisioning/" README.md AGENTS.md deploy/ ; echo "exit=$?"
ls deploy/hetzner/
```
Expected: "provisioning gone"; the grep prints **nothing** and `exit=1` (no matches); `ls` shows the four files.

- [ ] **Step 6: Verify app still builds/tests**

```bash
npm test && npx tsc --noEmit
```
Expected: PASS (deploy files aren't imported; this just confirms nothing else broke).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(deploy): move provisioning/ -> deploy/hetzner/ and fix path refs"
```

---

### Task 2: Docker path (headline)

Add a Dockerfile and compose file so `docker compose up -d` runs the whole app with a persistent SQLite volume and no secret baked into the image.

**Files:**
- Create: `deploy/docker/Dockerfile`
- Create: `deploy/docker/compose.yml`
- Create: `.dockerignore` (repo root)

**Interfaces:**
- Produces: `docker compose -f deploy/docker/compose.yml up -d` starts the app; web UI on host port 8080; DB persisted in a named volume `agent-data` at `/app/data`. Task 4's deploy/README references these commands.

- [ ] **Step 1: Create `.dockerignore` at repo root**

Prevents host `node_modules`, DB, git dir, and — critically — `.env` and local notes from entering the build context.

```
node_modules
data
.git
.env
*.local.md
dist
*.log
```

- [ ] **Step 2: Create `deploy/docker/Dockerfile`**

```dockerfile
# Rilo runs as a single Node process; tsx is a runtime dep (no build step).
FROM node:22-slim

# better-sqlite3 is native — ensure a toolchain is present for npm ci.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. Runtime deps only (tsx is among them).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (.dockerignore keeps .env / data / node_modules out).
COPY . .

# Drop privileges; give the app user ownership of the data dir.
RUN useradd --create-home app \
  && mkdir -p /app/data \
  && chown -R app:app /app
USER app

# Container-internal defaults; compose supplies the rest of the env.
ENV DB_PATH=/app/data/agent.db
ENV WEB_PORT=8080
EXPOSE 8080

CMD ["node", "--import", "tsx", "src/index.ts"]
```

- [ ] **Step 3: Create `deploy/docker/compose.yml`**

`environment:` overrides any `WEB_PORT`/`DB_PATH` coming from `.env`, so the container is self-consistent regardless of the user's `.env`. Only secrets/keys are taken from `.env`.

```yaml
services:
  app:
    build:
      context: ../..
      dockerfile: deploy/docker/Dockerfile
    env_file: ../../.env          # secrets: ENC_KEY, TELEGRAM_TOKEN, OPENROUTER_KEY, etc.
    environment:
      DB_PATH: /app/data/agent.db # override .env — must point at the volume
      WEB_PORT: "8080"            # container always listens on 8080
    ports:
      - "${HOST_PORT:-8080}:8080" # change the host side via HOST_PORT, not WEB_PORT
    volumes:
      - agent-data:/app/data      # SQLite persistence across restarts
    restart: unless-stopped

volumes:
  agent-data:
```

- [ ] **Step 4: Build the image (skip gracefully if Docker absent)**

```bash
command -v docker >/dev/null || { echo "SKIP: docker not installed"; exit 0; }
docker compose -f deploy/docker/compose.yml build
```
Expected: image builds; `npm ci` completes and `better-sqlite3` installs without error.

- [ ] **Step 5: Run and smoke-test (only if Docker present and a `.env` exists)**

```bash
docker compose -f deploy/docker/compose.yml up -d
sleep 5
curl -sf -o /dev/null -w "%{http_code}\n" http://localhost:8080/login   # expect 200
docker compose -f deploy/docker/compose.yml down                        # leave volume intact
```
Expected: `200`. (The `/login` route is public — see `src/web/server.ts` `PUBLIC_PATHS`.) If no `.env` is present locally, note that and skip the run step — the build step is the required gate.

- [ ] **Step 6: Verify secret is not in the image**

```bash
command -v docker >/dev/null && docker run --rm $(docker compose -f deploy/docker/compose.yml config --images | head -1) sh -c 'test ! -f /app/.env && echo "no .env in image"' || echo "SKIP"
```
Expected: "no .env in image" (or SKIP if Docker absent).

- [ ] **Step 7: Commit**

```bash
git add deploy/docker/Dockerfile deploy/docker/compose.yml .dockerignore
git commit -m "feat(deploy): Docker + compose path (persistent SQLite volume, no baked secrets)"
```

---

### Task 3: systemd path (bare-VPS)

A generic systemd unit template plus manual install steps, for users deploying to a Linux box they already have.

**Files:**
- Create: `deploy/systemd/personal-agent.service`
- Create: `deploy/systemd/README.md`

**Interfaces:**
- Produces: a unit template at a documented install path (`/etc/systemd/system/personal-agent.service`) and manual steps. Referenced by Task 4's deploy/README.

- [ ] **Step 1: Create `deploy/systemd/personal-agent.service`**

Same shape as the Hetzner unit but with a comment banner flagging the paths/user to adjust.

```ini
# Generic systemd unit for Rilo. Adjust WorkingDirectory, EnvironmentFile,
# ExecStart paths, and User to match your install location and service user.
[Unit]
Description=Rilo personal agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/personal-agent
EnvironmentFile=/opt/personal-agent/.env
ExecStart=/usr/bin/node --env-file=/opt/personal-agent/.env --import tsx /opt/personal-agent/src/index.ts
Restart=always
RestartSec=3
User=agent

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Create `deploy/systemd/README.md`**

````markdown
# Deploy with systemd (any Linux box)

Rilo is one Node process + a SQLite file. To run it under systemd:

1. **Install Node 22+** (e.g. via [nodesource](https://github.com/nodesource/distributions)) and `sqlite3`.
2. **Create a service user and directory:**
   ```bash
   sudo useradd --system --create-home --home-dir /opt/personal-agent agent
   sudo mkdir -p /opt/personal-agent/data
   ```
3. **Copy the app** to `/opt/personal-agent` (git clone or rsync), then:
   ```bash
   cd /opt/personal-agent
   sudo -u agent npm ci --omit=dev      # tsx is a runtime dep
   ```
4. **Create `/opt/personal-agent/.env`** from `.env.example` and fill it in.
5. **Install the unit** (adjust paths/user in the file first if your layout differs):
   ```bash
   sudo cp deploy/systemd/personal-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now personal-agent
   sudo systemctl status personal-agent
   ```
6. **Logs:** `journalctl -u personal-agent -f`

The web UI listens on `WEB_PORT` (default 8080). It has its own login gate, but
put it behind a firewall or reverse proxy — don't expose it wide open.
Telegram uses outbound long-polling, so no inbound port is needed for the bot.
````

- [ ] **Step 3: Verify files present**

```bash
ls deploy/systemd/ && head -3 deploy/systemd/personal-agent.service
```
Expected: both files listed; the comment banner prints.

- [ ] **Step 4: Commit**

```bash
git add deploy/systemd/
git commit -m "feat(deploy): generic systemd unit template + manual steps"
```

---

### Task 4: `deploy/README.md` — the deploy path chooser

The framing doc that says "one process, runs anywhere" and lists the paths, Docker first. This is what workstream #6's setup-agent will read.

**Files:**
- Create: `deploy/README.md`

**Interfaces:**
- Consumes: the `docker/`, `hetzner/`, `systemd/` dirs created in Tasks 1–3.

- [ ] **Step 1: Create `deploy/README.md`**

````markdown
# Deploying Rilo

Rilo is a **single Node process backed by a SQLite file**. It has no external
database or broker, and Telegram uses outbound long-polling — so it runs almost
anywhere. Pick the path that fits you:

## Docker (recommended)

Most portable — one command, persistent volume, no host Node setup.

```bash
cp .env.example .env      # fill it in (see the root README)
docker compose -f deploy/docker/compose.yml up -d
```

Web UI on http://localhost:8080. DB persists in the `agent-data` volume.
Change the host port with `HOST_PORT=9000 docker compose ... up -d`.
See [`docker/`](./docker/).

## Hetzner (one-command VPS)

Auto-provisions a locked-down Hetzner Cloud VPS (firewall restricted to your IP)
and deploys over SSH. One convenient option if you don't already have a server.
See [`hetzner/`](./hetzner/) and the root README's run order.

## Bare systemd (your own Linux box)

Run it under systemd on any VPS/home server you already have.
See [`systemd/`](./systemd/).

## Local (just run it)

```bash
npm install
cp .env.example .env      # fill it in
npm start
```

---

Whichever you pick, you provide the same secrets via `.env` (see `.env.example`
and the root README). Deployment-target choice never changes the app itself.
````

- [ ] **Step 2: Verify links resolve**

```bash
ls deploy/README.md deploy/docker deploy/hetzner deploy/systemd
```
Expected: all exist.

- [ ] **Step 3: Commit**

```bash
git add deploy/README.md
git commit -m "docs(deploy): deploy path chooser (Docker headline)"
```

---

### Task 5: Extract private instance details

Remove the author-specific "This instance (live)" section from README, add a committed template, and gitignore the real file.

**Files:**
- Modify: `README.md` (delete the "This instance (live)" section)
- Create: `deploy/hetzner/instance.local.md.example`
- Modify: `.gitignore`

**Interfaces:**
- Produces: gitignored `deploy/hetzner/instance.local.md` (author fills locally); committed `.example` template documents its shape. Adopters copy `.example` → `instance.local.md`.

- [ ] **Step 1: Delete the private section from README.md**

Remove the entire `#### This instance (live)` block (the bullet list with the live IP `<SERVER_IP>`, SSH key path, redeploy/log commands, and the prod-bot note). Verify it's gone:
```bash
grep -c "<SERVER_IP>" README.md
```
Expected: `0`.

- [ ] **Step 2: Create the template `deploy/hetzner/instance.local.md.example`**

```markdown
# My live instance (private — copy to instance.local.md, which is gitignored)

- Server: <PROVIDER/TYPE>, IP `<SERVER_IP>` (region <REGION>).
  Firewall locks SSH + UI to the owner IP only.
- SSH key: `<SSH_KEY_NAME>` (path `~/.ssh/<SSH_KEY_NAME>`); add a
  `Host <SERVER_IP>` block in `~/.ssh/config` so `ssh root@<SERVER_IP>` just works.
- Redeploy: `SERVER_IP=<SERVER_IP> ./deploy/hetzner/deploy.sh`
- Logs: `ssh root@<SERVER_IP> journalctl -u personal-agent -f`
- Prod secrets (bot token, ENC_KEY) live only in the server's /opt/personal-agent/.env —
  never here, never committed.
```

- [ ] **Step 3: Add ignore patterns to `.gitignore`**

Append:
```
# private per-instance ops notes (copy of instance.local.md.example)
**/instance.local.md
*.local.md
```

- [ ] **Step 4: Verify the ignore works and the template is tracked**

```bash
cp deploy/hetzner/instance.local.md.example deploy/hetzner/instance.local.md
git check-ignore deploy/hetzner/instance.local.md && echo "real file ignored"
git status --porcelain deploy/hetzner/instance.local.md.example   # should show it as new/tracked
git status --porcelain | grep -c "instance.local.md$"             # expect 0 (ignored, not shown)
```
Expected: "real file ignored"; the `.example` appears in status; the real file count is `0`.

- [ ] **Step 5: Commit (real instance.local.md stays out)**

```bash
git add README.md .gitignore deploy/hetzner/instance.local.md.example
git commit -m "chore: extract private instance details to gitignored instance.local.md"
```

---

### Task 6: Add MIT LICENSE

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Create `LICENSE` (MIT)**

```
MIT License

Copyright (c) 2026 Idan Cohen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Add a license field to package.json**

In `package.json`, add `"license": "MIT",` (after the `"version"` line).

- [ ] **Step 3: Verify**

```bash
head -1 LICENSE && node -e "console.log(require('./package.json').license)"
```
Expected: "MIT License" and `MIT`.

- [ ] **Step 4: Commit**

```bash
git add LICENSE package.json
git commit -m "chore: add MIT license"
```

---

### Task 7: Scrub git history and publish (FINAL — destructive)

Rewrite history to purge the live IP and SSH path from all commits, then push to a fresh public remote. **Irreversible without the backup made in Step 1.**

**Files:** none (history + remote operations).

**Preconditions:** Tasks 1–6 committed on `oss-prep`. Confirm with the user before running Steps 3–7 (history rewrite + push).

- [ ] **Step 1: Backup the whole repo (mandatory)**

```bash
git clone --mirror . ../personal-agent-backup.git
echo "backup at ../personal-agent-backup.git"
```

- [ ] **Step 2: Merge `oss-prep` into `main`**

The published branch is `main`. Bring the work over:
```bash
git checkout main
git merge --no-ff oss-prep -m "merge: open-source repo split (workstream #4)"
```

- [ ] **Step 3: Confirm `git-filter-repo` is installed**

```bash
git filter-repo --version || echo "INSTALL: brew install git-filter-repo (or pip install git-filter-repo)"
```
Expected: a version. If not, install it before continuing.

- [ ] **Step 4: Write the replacement expressions**

Create `$CLAUDE_JOB_DIR/tmp/scrub-expr.txt` (outside the repo so it isn't committed):
```
<SERVER_IP>==><SERVER_IP>
~/.ssh/<SSH_KEY_NAME>==>~/.ssh/<SSH_KEY_NAME>
```
(The `Host <SERVER_IP>` line and the redeploy/log commands all contain the IP, so the first line covers them. Region `nbg1` is a public Hetzner location and the generic script default — intentionally **not** scrubbed.)

- [ ] **Step 5: Rewrite history**

```bash
git filter-repo --replace-text "$CLAUDE_JOB_DIR/tmp/scrub-expr.txt" --force
```
Note: this rewrites every commit SHA across all branches and removes the existing `origin` by design.

- [ ] **Step 6: Verify the IP is gone from all of history**

```bash
git log --all -p | grep -c "<SERVER_IP>"          # expect 0
git log --all -p | grep -c "ssh/<SSH_KEY_NAME>"     # expect 0
```
Expected: both `0`. If either is non-zero, STOP — do not push; re-check the expression file.

- [ ] **Step 7: Add the public remote and push**

Requires an empty public GitHub repo (create via `gh repo create <name> --public` or the web UI). Then:
```bash
git remote add origin git@github.com:<user>/<repo>.git
git push -u origin main
```
Expected: push succeeds. Verify on GitHub that no commit contains the IP (search the repo for `188.245`).

- [ ] **Step 8: Post-publish sanity**

```bash
grep -rc "<SERVER_IP>" . --include=*.md --include=*.sh 2>/dev/null | grep -v ':0$' || echo "clean working tree"
```
Expected: "clean working tree".

---

## Notes / caveats

- **The spec and this plan currently contain the literal IP** (in the scrub instructions). `filter-repo` will rewrite those occurrences to `<SERVER_IP>` too — that's expected and harmless; the docs remain readable.
- After Task 7, the author's `deploy/hetzner/instance.local.md` (real values) sits untracked locally; the values are also in Claude memory `rilo-deployment.md`. Nothing is lost.
- If `better-sqlite3` fails to build in Docker on an unusual architecture, the toolchain (`python3 make g++`) is already installed in the image — check the `npm ci` log for the specific native error.
