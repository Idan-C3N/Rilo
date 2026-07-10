#!/usr/bin/env bash
# Usage:
#   HCLOUD_TOKEN=xxx OWNER_IP=1.2.3.4/32 WEB_PORT=8080 SSH_KEY_NAME=mykey ./provisioning/provision.sh
# Creates a Hetzner Cloud server with cloud-init, plus a firewall that:
#   - allows SSH (22) from OWNER_IP only
#   - allows the UI port from OWNER_IP only
#   - allows all outbound (Telegram long polling + OpenRouter + MCP)
set -euo pipefail
: "${HCLOUD_TOKEN:?}" ; : "${OWNER_IP:?e.g. 1.2.3.4/32}" ; : "${SSH_KEY_NAME:?}"
WEB_PORT="${WEB_PORT:-8080}"
SERVER_NAME="${SERVER_NAME:-personal-agent}"
SERVER_TYPE="${SERVER_TYPE:-cx22}"   # smallest shared-vCPU tier
IMAGE="${IMAGE:-ubuntu-24.04}"
LOCATION="${LOCATION:-nbg1}"
API="https://api.hetzner.cloud/v1"
auth=(-H "Authorization: Bearer ${HCLOUD_TOKEN}" -H "Content-Type: application/json")

# 1. Firewall
fw_id=$(curl -sf "${auth[@]}" -X POST "${API}/firewalls" -d @- <<JSON | python3 -c 'import sys,json;print(json.load(sys.stdin)["firewall"]["id"])'
{
  "name": "${SERVER_NAME}-fw",
  "rules": [
    {"direction":"in","protocol":"tcp","port":"22","source_ips":["${OWNER_IP}"]},
    {"direction":"in","protocol":"tcp","port":"${WEB_PORT}","source_ips":["${OWNER_IP}"]}
  ]
}
JSON
)
echo "firewall ${fw_id}"

# 2. Server with cloud-init + firewall attached
curl -sf "${auth[@]}" -X POST "${API}/servers" -d @- <<JSON | python3 -c 'import sys,json;d=json.load(sys.stdin);print("server", d["server"]["id"], d["server"]["public_net"]["ipv4"]["ip"])'
{
  "name": "${SERVER_NAME}",
  "server_type": "${SERVER_TYPE}",
  "image": "${IMAGE}",
  "location": "${LOCATION}",
  "ssh_keys": ["${SSH_KEY_NAME}"],
  "firewalls": [{"firewall": ${fw_id}}],
  "user_data": $(python3 -c 'import json,sys;print(json.dumps(open("provisioning/cloud-init.yaml").read()))')
}
JSON

echo "Server creating. Wait ~60s for cloud-init, then:"
echo "  1) scp your filled .env to root@<IP>:/opt/personal-agent/.env"
echo "  2) SERVER_IP=<IP> ./provisioning/deploy.sh"
