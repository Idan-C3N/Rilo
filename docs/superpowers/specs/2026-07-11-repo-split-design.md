# Repo Split for Open-Sourcing — Design

**Date:** 2026-07-11
**Workstream:** #4 of the open-source initiative (foundational; precedes UI, OAuth, setup-agent, README, security).
**Status:** Approved design, ready for implementation plan.

## Goal

Prepare the `personal-agent` (Rilo) repository to become a public, open-source
project without leaking the author's private infrastructure, while keeping the
deployment tooling as a **feature** for adopters rather than stripping it out.

The core tension resolved during brainstorming: the author initially wanted "all
deployment stuff" out of the public repo, but that conflicts with the goal
(workstream #6) of letting adopters easily pick a deploy target. Resolution:
deployment tooling is **generic and non-secret** and stays in the repo, reframed
as *one option among several*; only the author's **instance-specific** details are
private and get extracted + scrubbed from history.

## Non-goals (other workstreams)

- Full README rewrite for OSS — **#5**.
- Multi-target, agent-guided setup/onboarding — **#6**.
- Easier Google/Slack connection via OAuth — **#1**.
- Web UI / CSS overhaul — **#2**.
- Security + code-quality pass — **#3**.
- Tavily → Google Search swap — **#8**.

This spec references those seams but does not implement them.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Deployment tooling in OSS? | **Keep it**, reframed as options under `deploy/` |
| Headline deploy path | **Docker** (star); Hetzner + systemd are secondary, labeled alternatives |
| Write Docker + systemd now? | **Yes** — small, and needed so "Docker as the star" is backed by real files |
| Private ops details | Extracted to gitignored local file + already in author's Claude memory |
| Git history with live IP | **Keep history, scrub the IP** via `git-filter-repo` |
| Superpowers design specs | **Publish** — verified secret-free; seed of `docs/` |
| License | **MIT** |

## 1. Directory restructure: `provisioning/` → `deploy/`

Rilo is a single Node process plus a SQLite file — it runs anywhere. The new
layout makes that explicit and offers ready-made paths without implying lock-in.

```
deploy/
  README.md              # "Rilo is one process + a SQLite file. Runs anywhere. Pick a path:"
  docker/                # ★ headline path (NEW)
    Dockerfile
    compose.yml
  hetzner/               # one convenient VPS option (MOVED from provisioning/)
    provision.sh
    deploy.sh
    cloud-init.yaml
    personal-agent.service
    instance.local.md.example
  systemd/               # bare-VPS path (NEW)
    personal-agent.service
    README.md
```

`provisioning/` is removed; its four files move verbatim into `deploy/hetzner/`.
Any path references to `provisioning/` (README, `deploy.sh` internals if any,
AGENTS.md, the superpowers plan/spec prose) update to `deploy/hetzner/`.

### 1a. Docker path (NEW)

- **Dockerfile**: base `node:22-slim`; copy source; `npm ci`; run as a non-root
  user; the app keeps running via `tsx` (runtime dep, per AGENTS.md — no compile
  step); `EXPOSE` the web port; entrypoint `node --env-file=/app/.env --import tsx src/index.ts`
  (or read env from compose rather than a baked `.env`).
- **compose.yml**: one `app` service; bind/named volume mounting host `./data`
  → container DB dir so SQLite state persists; `env_file: ../../.env` (or an
  explicit `environment:` block); publish `WEB_PORT`. No second container — SQLite
  is in-process.
- Telegram uses **outbound long-poll**, so no inbound port is required for the bot;
  only the web UI port is published. Document that the web UI is unauthenticated at
  the network layer beyond the app's own session gate — advise binding to localhost
  + reverse proxy, or a firewall, in `deploy/README.md` (mirrors the Hetzner
  firewall model).

### 1b. systemd path (NEW, small)

- Generalize the existing `personal-agent.service` unit into a template with
  placeholder paths/user; keep the concrete one under `hetzner/` too.
- `deploy/systemd/README.md`: manual steps — install Node 22, create a service
  user, clone, `npm ci`, place `.env`, `systemctl enable --now`.

### 1c. `deploy/README.md`

Framing text + a short decision list:

- **Docker (recommended)** — `docker compose up -d`. Portable, one command.
- **Hetzner one-command** — `provision.sh` + `deploy.sh` for a locked-down VPS.
- **Bare systemd** — any Linux box you already have.
- **Local** — `npm start`.

This file is what workstream #6's setup-agent will read to present choices.

## 2. Private-details extraction

The only author-specific content in the working tree is README.md's
**"This instance (live)"** section (lines ~65–71): live IP `<SERVER_IP>`,
region, SSH key path `~/.ssh/<SSH_KEY_NAME>`, redeploy/log commands, prod-bot note.

- **Remove** that section from README.md.
- Create committed template `deploy/hetzner/instance.local.md.example` with
  placeholders (`<SERVER_IP>`, `<SSH_KEY_NAME>`, etc.).
- The author's real values live in a **gitignored** `deploy/hetzner/instance.local.md`
  (and are already captured in the author's Claude memory `rilo-deployment.md`, so
  nothing is lost by removing them from the repo).

### `.gitignore` additions

```
**/instance.local.md
*.local.md
```

`.env` and `data/` are already ignored; `data/agent.db` is confirmed untracked.

## 3. Git-history scrub

The live IP is baked into historical commits (README). Deleting it from the tip
does not remove it from history, so history must be rewritten before going public.

**Only secret in history:** the README instance section (IP + SSH details). The
superpowers specs/plans were grepped and contain only the *generic* `provision.sh`
with placeholders (`1.2.3.4/32`, `mykey`) — no real secrets. Region `nbg1` is a
public Hetzner location and already the generic script default — **not scrubbed**.

**Procedure:**

1. **Backup first:** `git clone --mirror . ../personal-agent-backup.git` (recover
   point if the rewrite goes wrong).
2. Install `git-filter-repo` (not shipped with git).
3. `expr.txt` for `--replace-text`:
   ```
   <SERVER_IP>==><SERVER_IP>
   regex:~/\.ssh/<SSH_KEY_NAME>==><SSH_KEY>
   ```
   (Add the `Host <SERVER_IP>` / redeploy / log lines' distinctive fragments if
   the section survives as prose after the README edit is *also* committed; the
   cleanest order is: commit the README edit removing the section, THEN filter-repo
   to purge the IP from all prior commits.)
4. Run `git filter-repo --replace-text expr.txt`.
5. **Verify:** `git log -p | grep -c 188.245` → must be `0`. Also grep for the SSH
   key path.
6. Add the new public GitHub repo as `origin`; push all branches.

**Caveat:** `filter-repo` rewrites every commit SHA and, by design, removes the
existing `origin`. That is acceptable — the target is a fresh public remote.

## 4. OSS hygiene

- Add **LICENSE** — MIT, author = Idan Cohen, year 2026.
- Add a top-of-README license line / badge (light touch; full README is #5).
- Confirm `data/agent.db*` not tracked (already gitignored).
- **Optional, flagged only:** rename package `personal-agent` → `rilo` in
  `package.json` for identity. Low priority; can defer to #5.

## 5. Verification checklist (definition of done)

- [ ] `deploy/` exists with `docker/`, `hetzner/`, `systemd/`, `README.md`; `provisioning/` gone.
- [ ] `docker compose up -d` starts the app; web UI reachable; SQLite persists across restarts.
- [ ] systemd template + README are accurate.
- [ ] README has no "This instance (live)" section; `instance.local.md.example` present; real `instance.local.md` gitignored.
- [ ] `git log -p | grep -c 188.245` == 0 (and SSH path clean).
- [ ] Backup mirror exists before the rewrite.
- [ ] LICENSE (MIT) present.
- [ ] All `provisioning/` path references updated to `deploy/hetzner/`.
- [ ] `npm test` + `npx tsc --noEmit` green (AGENTS.md gate).

## Risks / notes

- **History rewrite is irreversible** without the backup mirror — step 1 is mandatory.
- Publishing the superpowers specs is a deliberate choice (design-in-the-open);
  they can go stale vs code. Acceptable; they are dated.
- Docker path must not bake `.env` secrets into the image layer — use `env_file` /
  runtime env, never `COPY .env`.
