#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu/Debian box to run Rilo via Docker Compose.
# Installs Docker Engine + the compose plugin + git, clones the repo, and
# prepares the data dir. Run it ON the box (as root or with sudo).
#
#   REPO_URL=git@github.com:you/rilo.git ./deploy/provision.sh
#
# After it finishes:
#   1) cd /opt/personal-agent
#   2) cp .env.example .env  &&  edit .env  (secrets — see the root README)
#   3) docker compose up -d --build
#
# The host firewall (SSH + 8080 restricted to your IP) is managed at your VPS
# provider (console/API), not here — see deploy/README.md.
set -euo pipefail

REPO_URL="${REPO_URL:?set REPO_URL to the git remote to clone}"
APP_DIR="${APP_DIR:-/opt/personal-agent}"

echo "==> Installing Docker Engine + compose plugin + git"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
# get.docker.com bundles the compose plugin; ensure git too.
apt-get update -y
apt-get install -y --no-install-recommends git ca-certificates

echo "==> Cloning ${REPO_URL} -> ${APP_DIR}"
if [ -d "${APP_DIR}/.git" ]; then
  git -C "${APP_DIR}" pull --ff-only
else
  git clone "${REPO_URL}" "${APP_DIR}"
fi

echo "==> Preparing data dir"
mkdir -p "${APP_DIR}/data"

cat <<EOF

Done. Next:
  cd ${APP_DIR}
  cp .env.example .env    # then fill in secrets (see the root README)
  docker compose up -d --build

Redeploy later with:
  cd ${APP_DIR} && git pull && docker compose up -d --build
EOF
