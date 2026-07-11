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
