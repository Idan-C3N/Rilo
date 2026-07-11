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
