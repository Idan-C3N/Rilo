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
