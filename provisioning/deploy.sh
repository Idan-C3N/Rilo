#!/usr/bin/env bash
# Usage: SERVER_IP=x.x.x.x ./provisioning/deploy.sh
# Rsyncs the repo to the VPS, installs deps, (re)starts the service.
set -euo pipefail
: "${SERVER_IP:?set SERVER_IP}"
REMOTE="root@${SERVER_IP}"

rsync -az --delete \
  --exclude node_modules --exclude data --exclude .git --exclude .env \
  ./ "${REMOTE}:/opt/personal-agent/"

ssh "${REMOTE}" bash -s <<'EOF'
set -euo pipefail
cd /opt/personal-agent
npm ci --omit=dev || npm install --omit=dev   # tsx is a runtime dependency, pinned via package-lock
cp provisioning/personal-agent.service /etc/systemd/system/personal-agent.service
chown -R agent:agent /opt/personal-agent
systemctl daemon-reload
systemctl enable personal-agent
systemctl restart personal-agent
systemctl --no-pager status personal-agent | head -n 5
EOF
echo "Deployed to ${SERVER_IP}"
