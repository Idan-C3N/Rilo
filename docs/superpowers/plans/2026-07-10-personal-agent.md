# Personal Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A multi-user personal AI agent reachable over Telegram that chats reactively, fires exact-time reminders at any horizon, and autonomously self-checks on a heartbeat to proactively message the user — configurable models via OpenRouter, per-user MCP servers, a small web UI, running on one auto-provisioned cheap VPS.

**Architecture:** Single Node/TypeScript process. A channel-agnostic adapter (Telegram first, long polling) feeds an agent core built on the Vercel AI SDK (`generateText` + tools + per-user model). A scheduler persists jobs in SQLite and drives two proactive paths — exact reminders and a periodic heartbeat gate. Per-user config, MCP servers, memory, and history live in SQLite (secrets encrypted at rest). A Fastify + HTMX web UI (network-gated by firewall, identity via a Telegram magic code) edits model + MCP config.

**Tech Stack:** Node 22, TypeScript, `tsx`, Vitest, `better-sqlite3`, `grammy` (Telegram), Vercel AI SDK (`ai` v5) + `@ai-sdk/mcp` + `@openrouter/ai-sdk-provider`, `zod`, `fastify` + `@fastify/cookie` + `@fastify/formbody`, `libsodium-wrappers`.

## Global Constraints

- Runtime: **Node 22+**, ES modules (`"type": "module"`), TypeScript strict mode.
- All persistence in **one SQLite file** via `better-sqlite3` (synchronous API).
- Every DB query is **scoped by `user_id`**. No cross-user reads.
- **Secrets encrypted at rest**: OpenRouter keys + MCP creds. Encryption key from env var `ENC_KEY` (32-byte, base64). Plaintext secrets never written to SQLite.
- **Allowlist gate** before any LLM call: unknown Telegram IDs get a fixed "not authorized" reply and never reach a model.
- **Models via OpenRouter only** at launch. Model ids are OpenRouter strings, e.g. `anthropic/claude-3.5-sonnet`, `anthropic/claude-3.5-haiku`.
- Each user has a **cheap model** (routine turns + heartbeat gate + summarization) and a **strong model** (escalated turns).
- **Telegram via long polling** (outbound only). No public inbound at launch.
- Vercel AI SDK v5 API: tools use `tool({ description, inputSchema, execute })`; multi-step via `generateText({ ..., stopWhen: stepCountIs(n) })`.
- Tests never hit real Telegram, OpenRouter, or MCP servers — all mocked/faked.
- All times stored as **Unix epoch milliseconds (integer)** in UTC. Quiet hours + interval interpreted in the user's tz.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .env.example
src/
  config.ts                  # env loading + typed config
  index.ts                   # entrypoint: boot db, channels, scheduler, web
  crypto/encryption.ts       # encrypt/decrypt secrets with ENC_KEY
  db/
    db.ts                    # open sqlite, run migrations
    schema.sql               # table DDL
    users.ts                 # users repo + allowlist
    config.ts                # per-user model/key config repo
    messages.ts              # conversation history repo
    jobs.ts                  # scheduled jobs repo
    memory.ts                # durable memory repo
    mcp.ts                   # mcp_servers repo
    sessions.ts              # UI magic-code sessions repo
  channels/
    adapter.ts               # ChannelAdapter interface + types
    telegram.ts              # grammy impl: polling, typing indicator
  agent/
    models.ts                # resolve OpenRouter model for a user
    history.ts               # build context messages (recent + summary)
    summarize.ts             # rolling summarization
    core.ts                  # runAgentTurn(): the agent loop
    tools/
      index.ts               # assemble built-in tools for a user
      remind.ts              # schedule a reminder
      track.ts               # track a task + schedule follow-up
      memory.ts              # remember / recall
  mcp/manager.ts             # per-user MCP client lifecycle + tool assembly
  scheduler/
    scheduler.ts             # poll due jobs, dispatch by type
    heartbeat.ts             # heartbeat gate + escalation; quiet hours
  web/
    server.ts                # fastify app + startup
    auth.ts                  # magic code + session middleware
    render.ts                # tiny HTML layout helper
    routes/models.ts         # model config screen
    routes/mcp.ts            # mcp config screen
provisioning/
  cloud-init.yaml
  personal-agent.service
  deploy.sh
  provision.sh
tests/ (mirrors src/)
```

---

## Milestone 0 — Scaffold

### Task 1: Project scaffold + typed config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig` where
  `AppConfig = { dbPath: string; encKey: string; telegramToken: string; openrouterKeyFallback?: string; webPort: number; heartbeatDefaultMin: number }`. Throws if a required var is missing.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "personal-agent",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ai-sdk/mcp": "^1.0.0",
    "@fastify/cookie": "^10.0.0",
    "@fastify/formbody": "^8.0.0",
    "@openrouter/ai-sdk-provider": "^0.7.0",
    "ai": "^5.0.0",
    "better-sqlite3": "^11.0.0",
    "fastify": "^5.0.0",
    "grammy": "^1.30.0",
    "libsodium-wrappers": "^0.7.15",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/libsodium-wrappers": "^0.7.14",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
```

- [ ] **Step 4: Create `.env.example`**

```
DB_PATH=./data/agent.db
ENC_KEY=            # base64 of 32 random bytes: openssl rand -base64 32
TELEGRAM_TOKEN=
OPENROUTER_KEY=     # optional global fallback; per-user keys preferred
WEB_PORT=8080
HEARTBEAT_DEFAULT_MIN=30
```

- [ ] **Step 5: Write the failing test** — `tests/config.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DB_PATH: '/tmp/x.db',
  ENC_KEY: 'a'.repeat(44),
  TELEGRAM_TOKEN: 'tok',
  WEB_PORT: '8080',
  HEARTBEAT_DEFAULT_MIN: '30',
};

describe('loadConfig', () => {
  it('parses required vars with defaults', () => {
    const c = loadConfig(base as any);
    expect(c.dbPath).toBe('/tmp/x.db');
    expect(c.webPort).toBe(8080);
    expect(c.heartbeatDefaultMin).toBe(30);
  });

  it('throws when a required var is missing', () => {
    const { TELEGRAM_TOKEN, ...missing } = base;
    expect(() => loadConfig(missing as any)).toThrow(/TELEGRAM_TOKEN/);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm i && npx vitest run tests/config.test.ts`
Expected: FAIL — cannot find module `../src/config.js`.

- [ ] **Step 7: Implement `src/config.ts`**

```typescript
export interface AppConfig {
  dbPath: string;
  encKey: string;
  telegramToken: string;
  openrouterKeyFallback?: string;
  webPort: number;
  heartbeatDefaultMin: number;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    dbPath: req(env, 'DB_PATH'),
    encKey: req(env, 'ENC_KEY'),
    telegramToken: req(env, 'TELEGRAM_TOKEN'),
    openrouterKeyFallback: env.OPENROUTER_KEY || undefined,
    webPort: Number(env.WEB_PORT ?? '8080'),
    heartbeatDefaultMin: Number(env.HEARTBEAT_DEFAULT_MIN ?? '30'),
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .env.example src/config.ts tests/config.test.ts
git commit -m "chore: scaffold project + typed config"
```

---

## Milestone 1 — Working reactive bot

Deliverable at end of milestone: allowlisted Telegram user sends a message, sees "typing…", gets an LLM reply using their configured model; history persists.

### Task 2: Encryption module

**Files:**
- Create: `src/crypto/encryption.ts`
- Test: `tests/crypto/encryption.test.ts`

**Interfaces:**
- Produces: `initCrypto(base64Key: string): Promise<void>` (loads libsodium, sets key); `encrypt(plain: string): string` (returns base64 `nonce|cipher`); `decrypt(blob: string): string`. Uses XChaCha20-Poly1305 secretbox.

- [ ] **Step 1: Write the failing test** — `tests/crypto/encryption.test.ts`

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { initCrypto, encrypt, decrypt } from '../../src/crypto/encryption.js';
import sodium from 'libsodium-wrappers';

beforeAll(async () => {
  await sodium.ready;
  const key = sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL);
  await initCrypto(key);
});

describe('encryption', () => {
  it('round-trips a secret', () => {
    const secret = 'sk-or-v1-abc123';
    const blob = encrypt(secret);
    expect(blob).not.toContain(secret);
    expect(decrypt(blob)).toBe(secret);
  });

  it('produces different ciphertext each time (random nonce)', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/crypto/encryption.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/crypto/encryption.ts`**

```typescript
import sodium from 'libsodium-wrappers';

let key: Uint8Array | null = null;

export async function initCrypto(base64Key: string): Promise<void> {
  await sodium.ready;
  key = sodium.from_base64(base64Key, sodium.base64_variants.ORIGINAL);
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error(`ENC_KEY must decode to ${sodium.crypto_secretbox_KEYBYTES} bytes`);
  }
}

function requireKey(): Uint8Array {
  if (!key) throw new Error('crypto not initialized — call initCrypto first');
  return key;
}

export function encrypt(plain: string): string {
  const k = requireKey();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(sodium.from_string(plain), nonce, k);
  const combined = new Uint8Array(nonce.length + cipher.length);
  combined.set(nonce);
  combined.set(cipher, nonce.length);
  return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
}

export function decrypt(blob: string): string {
  const k = requireKey();
  const combined = sodium.from_base64(blob, sodium.base64_variants.ORIGINAL);
  const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const cipher = combined.slice(sodium.crypto_secretbox_NONCEBYTES);
  const plain = sodium.crypto_secretbox_open_easy(cipher, nonce, k);
  return sodium.to_string(plain);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/crypto/encryption.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/crypto/encryption.ts tests/crypto/encryption.test.ts
git commit -m "feat: secret encryption via libsodium secretbox"
```

---

### Task 3: DB core + schema

**Files:**
- Create: `src/db/db.ts`, `src/db/schema.sql`
- Test: `tests/db/db.test.ts`

**Interfaces:**
- Produces: `openDb(path: string): Database` (from `better-sqlite3`), runs `schema.sql` idempotently (all `CREATE TABLE IF NOT EXISTS`). `path` may be `:memory:` for tests. Enables `PRAGMA journal_mode=WAL; foreign_keys=ON`.

- [ ] **Step 1: Create `src/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT UNIQUE,
  phone TEXT,
  name TEXT,
  tz TEXT NOT NULL DEFAULT 'UTC',
  quiet_start INTEGER NOT NULL DEFAULT 22,   -- hour 0-23 local
  quiet_end INTEGER NOT NULL DEFAULT 8,
  heartbeat_interval_min INTEGER NOT NULL DEFAULT 30,
  allowlisted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cheap_model TEXT NOT NULL DEFAULT 'anthropic/claude-3.5-haiku',
  strong_model TEXT NOT NULL DEFAULT 'anthropic/claude-3.5-sonnet',
  openrouter_key_enc TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,           -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);

CREATE TABLE IF NOT EXISTS summaries (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  last_summarized_msg_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,           -- 'reminder' | 'followup' | 'heartbeat'
  fire_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'done' | 'cancelled'
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, fire_at);

CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mkey TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_user ON memory(user_id);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,      -- 'stdio' | 'http' | 'sse'
  command TEXT,                 -- stdio: executable
  args_json TEXT NOT NULL DEFAULT '[]',
  url TEXT,                     -- http/sse
  creds_enc TEXT,               -- encrypted JSON (headers/env)
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_mcp_user ON mcp_servers(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT,                    -- pending magic code; NULL once consumed
  verified INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Write the failing test** — `tests/db/db.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';

describe('openDb', () => {
  it('creates all tables idempotently', () => {
    const db = openDb(':memory:');
    // second call on same file path would re-run; here just verify tables exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r: any) => r.name);
    for (const t of ['users', 'config', 'messages', 'jobs', 'memory', 'mcp_servers', 'sessions', 'summaries']) {
      expect(tables).toContain(t);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/db/db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/db/db.ts`**

```typescript
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type DB = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/db/db.test.ts`
Expected: PASS.

Note: `schema.sql` must be copied next to the compiled file. Since we run via `tsx` (no build step in dev/prod), `import.meta.url` points at `src/db/`, so the `.sql` is found. Provisioning runs `tsx src/index.ts` directly — no copy needed.

- [ ] **Step 6: Commit**

```bash
git add src/db/db.ts src/db/schema.sql tests/db/db.test.ts
git commit -m "feat: sqlite schema + openDb"
```

---

### Task 4: Users repo + allowlist

**Files:**
- Create: `src/db/users.ts`
- Test: `tests/db/users.test.ts`

**Interfaces:**
- Consumes: `DB` from `db.ts`.
- Produces: `User` type `{ id, telegram_id, name, tz, quiet_start, quiet_end, heartbeat_interval_min, allowlisted }`; `getUserByTelegramId(db, tgId): User | undefined`; `createUser(db, { telegram_id, name, heartbeat_interval_min }): User` (created not allowlisted; also inserts default `config` row); `isAllowlisted(db, tgId): boolean`; `setAllowlisted(db, userId, on): void`; `listUsers(db): User[]`; `listAllowlisted(db): User[]`.

- [ ] **Step 1: Write the failing test** — `tests/db/users.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser, getUserByTelegramId, isAllowlisted, setAllowlisted } from '../../src/db/users.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('users repo', () => {
  it('creates a user, not allowlisted by default, with a config row', () => {
    const u = createUser(db, { telegram_id: '123', name: 'Ann', heartbeat_interval_min: 30 });
    expect(u.id).toBeGreaterThan(0);
    expect(isAllowlisted(db, '123')).toBe(false);
    const cfg = db.prepare('SELECT * FROM config WHERE user_id=?').get(u.id) as any;
    expect(cfg.cheap_model).toContain('haiku');
  });

  it('allowlists a user', () => {
    const u = createUser(db, { telegram_id: '9', name: 'B', heartbeat_interval_min: 30 });
    setAllowlisted(db, u.id, true);
    expect(isAllowlisted(db, '9')).toBe(true);
  });

  it('finds by telegram id', () => {
    createUser(db, { telegram_id: 'tg', name: 'C', heartbeat_interval_min: 15 });
    expect(getUserByTelegramId(db, 'tg')?.name).toBe('C');
    expect(getUserByTelegramId(db, 'nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/users.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/db/users.ts`**

```typescript
import type { DB } from './db.js';

export interface User {
  id: number;
  telegram_id: string | null;
  name: string | null;
  tz: string;
  quiet_start: number;
  quiet_end: number;
  heartbeat_interval_min: number;
  allowlisted: number;
}

export function getUserByTelegramId(db: DB, tgId: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId) as User | undefined;
}

export function createUser(
  db: DB,
  opts: { telegram_id: string; name?: string; heartbeat_interval_min: number },
): User {
  const info = db
    .prepare(
      'INSERT INTO users (telegram_id, name, heartbeat_interval_min, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(opts.telegram_id, opts.name ?? null, opts.heartbeat_interval_min, nowMs());
  const userId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO config (user_id) VALUES (?)').run(userId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User;
}

export function isAllowlisted(db: DB, tgId: string): boolean {
  const row = db.prepare('SELECT allowlisted FROM users WHERE telegram_id = ?').get(tgId) as
    | { allowlisted: number }
    | undefined;
  return !!row && row.allowlisted === 1;
}

export function setAllowlisted(db: DB, userId: number, on: boolean): void {
  db.prepare('UPDATE users SET allowlisted = ? WHERE id = ?').run(on ? 1 : 0, userId);
}

export function listUsers(db: DB): User[] {
  return db.prepare('SELECT * FROM users').all() as User[];
}

export function listAllowlisted(db: DB): User[] {
  return db.prepare('SELECT * FROM users WHERE allowlisted = 1').all() as User[];
}

function nowMs(): number {
  return Date.now();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/users.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/users.ts tests/db/users.test.ts
git commit -m "feat: users repo + allowlist"
```

---

### Task 5: Config repo (models + encrypted key)

**Files:**
- Create: `src/db/config.ts`
- Test: `tests/db/config.test.ts`

**Interfaces:**
- Consumes: `DB`; `encrypt`/`decrypt` from `crypto/encryption.ts`.
- Produces: `UserConfig` `{ user_id, cheap_model, strong_model, settings: Record<string, unknown> }`; `getConfig(db, userId): UserConfig`; `setModels(db, userId, { cheap_model?, strong_model? }): void`; `setOpenrouterKey(db, userId, plainKey): void` (encrypts); `getOpenrouterKey(db, userId): string | undefined` (decrypts).

- [ ] **Step 1: Write the failing test** — `tests/db/config.test.ts`

```typescript
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { getConfig, setModels, setOpenrouterKey, getOpenrouterKey } from '../../src/db/config.js';

let db: DB, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
});

describe('config repo', () => {
  it('updates models', () => {
    setModels(db, uid, { strong_model: 'anthropic/claude-3.7-sonnet' });
    expect(getConfig(db, uid).strong_model).toBe('anthropic/claude-3.7-sonnet');
  });

  it('stores openrouter key encrypted and reads it back', () => {
    setOpenrouterKey(db, uid, 'sk-or-secret');
    const raw = db.prepare('SELECT openrouter_key_enc FROM config WHERE user_id=?').get(uid) as any;
    expect(raw.openrouter_key_enc).not.toContain('sk-or-secret');
    expect(getOpenrouterKey(db, uid)).toBe('sk-or-secret');
  });

  it('returns undefined key when unset', () => {
    expect(getOpenrouterKey(db, uid)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/db/config.ts`**

```typescript
import type { DB } from './db.js';
import { encrypt, decrypt } from '../crypto/encryption.js';

export interface UserConfig {
  user_id: number;
  cheap_model: string;
  strong_model: string;
  settings: Record<string, unknown>;
}

interface Row {
  user_id: number;
  cheap_model: string;
  strong_model: string;
  openrouter_key_enc: string | null;
  settings_json: string;
}

export function getConfig(db: DB, userId: number): UserConfig {
  const r = db.prepare('SELECT * FROM config WHERE user_id = ?').get(userId) as Row | undefined;
  if (!r) throw new Error(`no config for user ${userId}`);
  return {
    user_id: r.user_id,
    cheap_model: r.cheap_model,
    strong_model: r.strong_model,
    settings: JSON.parse(r.settings_json),
  };
}

export function setModels(
  db: DB,
  userId: number,
  m: { cheap_model?: string; strong_model?: string },
): void {
  const cur = getConfig(db, userId);
  db.prepare('UPDATE config SET cheap_model = ?, strong_model = ? WHERE user_id = ?').run(
    m.cheap_model ?? cur.cheap_model,
    m.strong_model ?? cur.strong_model,
    userId,
  );
}

export function setOpenrouterKey(db: DB, userId: number, plainKey: string): void {
  db.prepare('UPDATE config SET openrouter_key_enc = ? WHERE user_id = ?').run(
    encrypt(plainKey),
    userId,
  );
}

export function getOpenrouterKey(db: DB, userId: number): string | undefined {
  const r = db.prepare('SELECT openrouter_key_enc FROM config WHERE user_id = ?').get(userId) as
    | { openrouter_key_enc: string | null }
    | undefined;
  if (!r || !r.openrouter_key_enc) return undefined;
  return decrypt(r.openrouter_key_enc);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/config.ts tests/db/config.test.ts
git commit -m "feat: per-user config repo with encrypted openrouter key"
```

---

### Task 6: Messages repo (history)

**Files:**
- Create: `src/db/messages.ts`
- Test: `tests/db/messages.test.ts`

**Interfaces:**
- Consumes: `DB`.
- Produces: `Message` `{ id, user_id, role, content, created_at }`; `addMessage(db, userId, role, content): number` (returns new id); `recentMessages(db, userId, limit): Message[]` (chronological ascending, last `limit`); `messagesSince(db, userId, sinceId): Message[]`.

- [ ] **Step 1: Write the failing test** — `tests/db/messages.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { addMessage, recentMessages, messagesSince } from '../../src/db/messages.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
});

describe('messages repo', () => {
  it('stores and returns recent messages in order, capped', () => {
    for (let i = 0; i < 5; i++) addMessage(db, uid, 'user', `m${i}`);
    const recent = recentMessages(db, uid, 3);
    expect(recent.map((m) => m.content)).toEqual(['m2', 'm3', 'm4']);
  });

  it('messagesSince returns only newer rows', () => {
    const id1 = addMessage(db, uid, 'user', 'a');
    addMessage(db, uid, 'assistant', 'b');
    expect(messagesSince(db, uid, id1).map((m) => m.content)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/messages.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/db/messages.ts`**

```typescript
import type { DB } from './db.js';

export type Role = 'user' | 'assistant' | 'system';
export interface Message {
  id: number;
  user_id: number;
  role: Role;
  content: string;
  created_at: number;
}

export function addMessage(db: DB, userId: number, role: Role, content: string): number {
  const info = db
    .prepare('INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, role, content, Date.now());
  return Number(info.lastInsertRowid);
}

export function recentMessages(db: DB, userId: number, limit: number): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit) as Message[];
  return rows.reverse();
}

export function messagesSince(db: DB, userId: number, sinceId: number): Message[] {
  return db
    .prepare('SELECT * FROM messages WHERE user_id = ? AND id > ? ORDER BY id ASC')
    .all(userId, sinceId) as Message[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/messages.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/messages.ts tests/db/messages.test.ts
git commit -m "feat: messages repo"
```

---

### Task 7: Model resolver

**Files:**
- Create: `src/agent/models.ts`
- Test: `tests/agent/models.test.ts`

**Interfaces:**
- Consumes: `DB`; `getConfig`, `getOpenrouterKey` from `db/config.ts`; `AppConfig`.
- Produces: `resolveModels(db, appCfg, userId): { cheap: LanguageModel; strong: LanguageModel }` using `@openrouter/ai-sdk-provider`. Prefers the user's key; falls back to `appCfg.openrouterKeyFallback`; throws a clear error if neither exists.

- [ ] **Step 1: Write the failing test** — `tests/agent/models.test.ts`

```typescript
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { setOpenrouterKey } from '../../src/db/config.js';
import { resolveModels } from '../../src/agent/models.js';

const appCfg = { openrouterKeyFallback: undefined } as any;
let db: DB, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
});

describe('resolveModels', () => {
  it('throws when no key available', () => {
    expect(() => resolveModels(db, appCfg, uid)).toThrow(/OpenRouter key/i);
  });

  it('returns cheap + strong models when a user key exists', () => {
    setOpenrouterKey(db, uid, 'sk-or-test');
    const m = resolveModels(db, appCfg, uid);
    expect(m.cheap).toBeDefined();
    expect(m.strong).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/models.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent/models.ts`**

```typescript
import type { LanguageModel } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { getConfig, getOpenrouterKey } from '../db/config.js';

export function resolveModels(
  db: DB,
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>,
  userId: number,
): { cheap: LanguageModel; strong: LanguageModel } {
  const apiKey = getOpenrouterKey(db, userId) ?? appCfg.openrouterKeyFallback;
  if (!apiKey) {
    throw new Error('No OpenRouter key for user and no fallback configured');
  }
  const openrouter = createOpenRouter({ apiKey });
  const cfg = getConfig(db, userId);
  return {
    cheap: openrouter(cfg.cheap_model),
    strong: openrouter(cfg.strong_model),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/models.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/models.ts tests/agent/models.test.ts
git commit -m "feat: per-user OpenRouter model resolver"
```

---

### Task 8: Agent core (reactive turn)

**Files:**
- Create: `src/agent/core.ts`
- Test: `tests/agent/core.test.ts`

**Interfaces:**
- Consumes: `DB`, `AppConfig`, `recentMessages`/`addMessage` from `db/messages.ts`, `resolveModels`.
- Produces: `runAgentTurn(deps, opts): Promise<string>` where
  `deps = { db; appCfg; generate: GenerateFn; buildTools?: (userId) => Promise<ToolSet> }` and
  `opts = { userId; input: string; system?: string; useStrong?: boolean }`.
  `GenerateFn` is the injection seam for `generateText` (default wired in Task 10):
  `type GenerateFn = (args: { model: LanguageModel; system?: string; messages: CoreMessage[]; tools?: ToolSet; stopWhen?: any }) => Promise<{ text: string }>`.
  Behavior: persist the user message, load recent history, call `generate`, persist + return assistant text.

- [ ] **Step 1: Write the failing test** — `tests/agent/core.test.ts`

```typescript
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { setOpenrouterKey } from '../../src/db/config.js';
import { recentMessages } from '../../src/db/messages.js';
import { runAgentTurn } from '../../src/agent/core.js';

let db: DB, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
  setOpenrouterKey(db, uid, 'sk-or-test');
});

describe('runAgentTurn', () => {
  it('persists user + assistant messages and returns reply', async () => {
    const generate = async (args: any) => {
      // last message is the user's input
      expect(args.messages.at(-1).content).toBe('hello');
      return { text: 'hi there' };
    };
    const reply = await runAgentTurn(
      { db, appCfg: {} as any, generate },
      { userId: uid, input: 'hello' },
    );
    expect(reply).toBe('hi there');
    const hist = recentMessages(db, uid, 10);
    expect(hist.map((m) => `${m.role}:${m.content}`)).toEqual(['user:hello', 'assistant:hi there']);
  });

  it('passes prior history into the model', async () => {
    await runAgentTurn({ db, appCfg: {} as any, generate: async () => ({ text: 'a1' }) }, { userId: uid, input: 'q1' });
    let seen: any[] = [];
    const generate = async (args: any) => { seen = args.messages; return { text: 'a2' }; };
    await runAgentTurn({ db, appCfg: {} as any, generate }, { userId: uid, input: 'q2' });
    expect(seen.map((m) => m.content)).toEqual(['q1', 'a1', 'q2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/core.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent/core.ts`**

```typescript
import type { CoreMessage, LanguageModel, ToolSet } from 'ai';
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { addMessage, recentMessages } from '../db/messages.js';
import { resolveModels } from './models.js';

const HISTORY_LIMIT = 20;

export type GenerateFn = (args: {
  model: LanguageModel;
  system?: string;
  messages: CoreMessage[];
  tools?: ToolSet;
  stopWhen?: unknown;
}) => Promise<{ text: string }>;

export interface AgentDeps {
  db: DB;
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>;
  generate: GenerateFn;
  buildTools?: (userId: number) => Promise<ToolSet>;
}

export interface TurnOpts {
  userId: number;
  input: string;
  system?: string;
  useStrong?: boolean;
}

export async function runAgentTurn(deps: AgentDeps, opts: TurnOpts): Promise<string> {
  const { db } = deps;
  addMessage(db, opts.userId, 'user', opts.input);

  const history = recentMessages(db, opts.userId, HISTORY_LIMIT);
  const messages: CoreMessage[] = history.map((m) => ({
    role: m.role === 'system' ? 'system' : m.role,
    content: m.content,
  })) as CoreMessage[];

  const models = resolveModels(db, deps.appCfg, opts.userId);
  const model = opts.useStrong ? models.strong : models.cheap;
  const tools = deps.buildTools ? await deps.buildTools(opts.userId) : undefined;

  const result = await deps.generate({
    model,
    system: opts.system,
    messages,
    tools,
  });

  addMessage(db, opts.userId, 'assistant', result.text);
  return result.text;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/core.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/core.ts tests/agent/core.test.ts
git commit -m "feat: agent core reactive turn with injectable generate"
```

---

### Task 9: Channel adapter interface + Telegram

**Files:**
- Create: `src/channels/adapter.ts`, `src/channels/telegram.ts`
- Test: `tests/channels/telegram.test.ts`

**Interfaces:**
- Produces (`adapter.ts`): `interface InboundMessage { channelUserId: string; text: string; name?: string }`; `interface ChannelAdapter { start(): void; stop(): Promise<void>; send(channelUserId: string, text: string): Promise<void>; onMessage(handler: (m: InboundMessage) => Promise<void>): void; }`; `interface TypingController { start(): void; stop(): void }`.
- Produces (`telegram.ts`): `createTelegramAdapter(deps): ChannelAdapter & { typingFor(channelUserId): TypingController }` where `deps = { token: string; makeBot?: (token) => BotLike }`. `BotLike` is a minimal interface over grammY so tests inject a fake: `{ on(event, cb): void; start(): void; stop(): Promise<void>; api: { sendMessage(chatId, text): Promise<unknown>; sendChatAction(chatId, action): Promise<unknown> } }`. Typing controller calls `sendChatAction(chatId, 'typing')` immediately then every 4000ms until `stop()`.

- [ ] **Step 1: Implement `src/channels/adapter.ts`** (no test — pure types/interface)

```typescript
export interface InboundMessage {
  channelUserId: string;
  text: string;
  name?: string;
}

export interface TypingController {
  start(): void;
  stop(): void;
}

export interface ChannelAdapter {
  start(): void;
  stop(): Promise<void>;
  send(channelUserId: string, text: string): Promise<void>;
  onMessage(handler: (m: InboundMessage) => Promise<void>): void;
}
```

- [ ] **Step 2: Write the failing test** — `tests/channels/telegram.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createTelegramAdapter } from '../../src/channels/telegram.js';

function fakeBot() {
  const calls: any = { sendMessage: [], sendChatAction: [] };
  let handler: (ctx: any) => Promise<void>;
  return {
    calls,
    fire: (ctx: any) => handler(ctx),
    bot: {
      on: (_event: string, cb: any) => { handler = cb; },
      start: () => {},
      stop: async () => {},
      api: {
        sendMessage: async (id: string, text: string) => { calls.sendMessage.push([id, text]); },
        sendChatAction: async (id: string, a: string) => { calls.sendChatAction.push([id, a]); },
      },
    },
  };
}

describe('telegram adapter', () => {
  it('routes inbound text to the handler and can send', async () => {
    const f = fakeBot();
    const adapter = createTelegramAdapter({ token: 'x', makeBot: () => f.bot as any });
    const received: any[] = [];
    adapter.onMessage(async (m) => { received.push(m); });
    adapter.start();
    await f.fire({ from: { id: 42, first_name: 'Ann' }, message: { text: 'hi' } });
    expect(received[0]).toEqual({ channelUserId: '42', text: 'hi', name: 'Ann' });
    await adapter.send('42', 'yo');
    expect(f.calls.sendMessage).toEqual([['42', 'yo']]);
  });

  it('typing controller sends typing immediately and repeats on interval', () => {
    vi.useFakeTimers();
    const f = fakeBot();
    const adapter = createTelegramAdapter({ token: 'x', makeBot: () => f.bot as any });
    const t = adapter.typingFor('7');
    t.start();
    expect(f.calls.sendChatAction).toEqual([['7', 'typing']]);
    vi.advanceTimersByTime(4000);
    expect(f.calls.sendChatAction.length).toBe(2);
    t.stop();
    vi.advanceTimersByTime(8000);
    expect(f.calls.sendChatAction.length).toBe(2);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/channels/telegram.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/channels/telegram.ts`**

```typescript
import { Bot } from 'grammy';
import type { ChannelAdapter, InboundMessage, TypingController } from './adapter.js';

export interface BotLike {
  on(event: 'message:text', cb: (ctx: any) => Promise<void> | void): void;
  start(): void;
  stop(): Promise<void>;
  api: {
    sendMessage(chatId: string | number, text: string): Promise<unknown>;
    sendChatAction(chatId: string | number, action: string): Promise<unknown>;
  };
}

export interface TelegramDeps {
  token: string;
  makeBot?: (token: string) => BotLike;
}

const TYPING_INTERVAL_MS = 4000;

export function createTelegramAdapter(
  deps: TelegramDeps,
): ChannelAdapter & { typingFor(channelUserId: string): TypingController } {
  const bot: BotLike = deps.makeBot ? deps.makeBot(deps.token) : (new Bot(deps.token) as unknown as BotLike);
  let handler: ((m: InboundMessage) => Promise<void>) | null = null;

  bot.on('message:text', async (ctx: any) => {
    if (!handler) return;
    await handler({
      channelUserId: String(ctx.from.id),
      text: ctx.message.text,
      name: ctx.from.first_name,
    });
  });

  return {
    start: () => bot.start(),
    stop: () => bot.stop(),
    onMessage: (h) => { handler = h; },
    send: async (channelUserId, text) => {
      await bot.api.sendMessage(channelUserId, text);
    },
    typingFor: (channelUserId): TypingController => {
      let timer: ReturnType<typeof setInterval> | null = null;
      return {
        start: () => {
          void bot.api.sendChatAction(channelUserId, 'typing');
          timer = setInterval(() => {
            void bot.api.sendChatAction(channelUserId, 'typing');
          }, TYPING_INTERVAL_MS);
        },
        stop: () => {
          if (timer) clearInterval(timer);
          timer = null;
        },
      };
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/channels/telegram.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/channels/adapter.ts src/channels/telegram.ts tests/channels/telegram.test.ts
git commit -m "feat: channel adapter interface + telegram (polling, typing)"
```

---

### Task 10: Wire the reactive path (entrypoint)

**Files:**
- Create: `src/index.ts`
- Create: `src/agent/dispatch.ts` (glue: resolve/create user, allowlist, typing, run turn)
- Test: `tests/agent/dispatch.test.ts`

**Interfaces:**
- Produces (`dispatch.ts`): `handleInbound(deps, m): Promise<void>` where
  `deps = { db; appCfg; adapter: Pick<ChannelAdapter,'send'> & { typingFor(id): TypingController }; runTurn: typeof runAgentTurn; generate: GenerateFn; heartbeatDefaultMin: number }`.
  Behavior: find-or-create user by `channelUserId`; if not allowlisted → `adapter.send(id, NOT_AUTHORIZED)` and stop (no LLM); else start typing, run turn, send reply, stop typing (in `finally`). Export `NOT_AUTHORIZED` constant.
- `index.ts` wires real deps: loads env (`dotenv` via `node --env-file` or `process.env`), `initCrypto`, `openDb`, real `generateText` wrapper, `createTelegramAdapter`, registers `handleInbound`, starts scheduler + web (added later), calls `adapter.start()`.

- [ ] **Step 1: Write the failing test** — `tests/agent/dispatch.test.ts`

```typescript
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser, setAllowlisted, getUserByTelegramId } from '../../src/db/users.js';
import { setOpenrouterKey } from '../../src/db/config.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { handleInbound, NOT_AUTHORIZED } from '../../src/agent/dispatch.js';
import { runAgentTurn } from '../../src/agent/core.js';

let db: DB;
const sent: any[] = [];
const typingEvents: string[] = [];
const adapter = {
  send: async (id: string, text: string) => { sent.push([id, text]); },
  typingFor: (_id: string) => ({ start: () => typingEvents.push('start'), stop: () => typingEvents.push('stop') }),
};
const deps = () => ({
  db, appCfg: {} as any, adapter, runTurn: runAgentTurn,
  generate: async () => ({ text: 'reply!' }), heartbeatDefaultMin: 30,
});

beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => { db = openDb(':memory:'); sent.length = 0; typingEvents.length = 0; });

describe('handleInbound', () => {
  it('rejects non-allowlisted users without calling the model', async () => {
    await handleInbound(deps(), { channelUserId: '5', text: 'hi', name: 'X' });
    expect(sent).toEqual([['5', NOT_AUTHORIZED]]);
    // user auto-created but not allowlisted
    expect(getUserByTelegramId(db, '5')?.allowlisted).toBe(0);
  });

  it('runs a turn for an allowlisted user with typing lifecycle', async () => {
    const u = createUser(db, { telegram_id: '9', heartbeat_interval_min: 30 });
    setAllowlisted(db, u.id, true);
    setOpenrouterKey(db, u.id, 'sk-or');
    await handleInbound(deps(), { channelUserId: '9', text: 'hi', name: 'Y' });
    expect(sent).toEqual([['9', 'reply!']]);
    expect(typingEvents).toEqual(['start', 'stop']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/dispatch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent/dispatch.ts`**

```typescript
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import type { InboundMessage, ChannelAdapter, TypingController } from '../channels/adapter.js';
import { getUserByTelegramId, createUser, isAllowlisted } from '../db/users.js';
import type { runAgentTurn, GenerateFn } from './core.js';

export const NOT_AUTHORIZED =
  'You are not authorized to use this assistant. Ask the owner to allowlist you.';

export interface DispatchDeps {
  db: DB;
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>;
  adapter: Pick<ChannelAdapter, 'send'> & { typingFor(id: string): TypingController };
  runTurn: typeof runAgentTurn;
  generate: GenerateFn;
  buildTools?: (userId: number) => Promise<import('ai').ToolSet>;
  heartbeatDefaultMin: number;
}

export async function handleInbound(deps: DispatchDeps, m: InboundMessage): Promise<void> {
  const { db } = deps;
  let user = getUserByTelegramId(db, m.channelUserId);
  if (!user) {
    user = createUser(db, {
      telegram_id: m.channelUserId,
      name: m.name,
      heartbeat_interval_min: deps.heartbeatDefaultMin,
    });
  }
  if (!isAllowlisted(db, m.channelUserId)) {
    await deps.adapter.send(m.channelUserId, NOT_AUTHORIZED);
    return;
  }
  const typing = deps.adapter.typingFor(m.channelUserId);
  typing.start();
  try {
    const reply = await deps.runTurn(
      { db, appCfg: deps.appCfg, generate: deps.generate, buildTools: deps.buildTools },
      { userId: user.id, input: m.text },
    );
    await deps.adapter.send(m.channelUserId, reply);
  } finally {
    typing.stop();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/dispatch.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `src/index.ts`** (wires real dependencies; no unit test — smoke-tested manually)

```typescript
import { generateText, stepCountIs, type CoreMessage } from 'ai';
import { loadConfig } from './config.js';
import { initCrypto } from './crypto/encryption.js';
import { openDb } from './db/db.js';
import { createTelegramAdapter } from './channels/telegram.js';
import { handleInbound } from './agent/dispatch.js';
import type { GenerateFn } from './agent/core.js';
import { buildToolsFor } from './agent/tools/index.js';
import { startScheduler } from './scheduler/scheduler.js';
import { startWeb } from './web/server.js';

const appCfg = loadConfig(process.env);
await initCrypto(appCfg.encKey);
const db = openDb(appCfg.dbPath);

const generate: GenerateFn = async (args) =>
  generateText({
    model: args.model,
    system: args.system,
    messages: args.messages as CoreMessage[],
    tools: args.tools,
    stopWhen: stepCountIs(8),
  });

const adapter = createTelegramAdapter({ token: appCfg.telegramToken });
const buildTools = (userId: number) => buildToolsFor({ db, userId });

adapter.onMessage((m) =>
  handleInbound(
    { db, appCfg, adapter, runTurn: (await import('./agent/core.js')).runAgentTurn, generate, buildTools, heartbeatDefaultMin: appCfg.heartbeatDefaultMin },
    m,
  ),
);

startScheduler({ db, appCfg, adapter, generate });
await startWeb({ db, appCfg, adapter });
adapter.start();
console.log('personal-agent running');
```

Note: the `await import` inside the arrow is awkward — instead import `runAgentTurn` at top. Replace the handler with a top-level import:

```typescript
import { runAgentTurn } from './agent/core.js';
// ...
adapter.onMessage((m) =>
  handleInbound(
    { db, appCfg, adapter, runTurn: runAgentTurn, generate, buildTools, heartbeatDefaultMin: appCfg.heartbeatDefaultMin },
    m,
  ),
);
```

(`buildToolsFor`, `startScheduler`, `startWeb` are implemented in later tasks. Until Task 12/13/24 land, temporarily stub these imports or comment the lines to smoke-test the reactive path.)

- [ ] **Step 6: Manual smoke test (reactive path)**

With a real `.env` (test bot token + OpenRouter key), temporarily comment scheduler/web/buildTools lines. Run: `node --env-file=.env --import tsx src/index.ts`. Message the bot from an allowlisted Telegram account (allowlist yourself by setting `allowlisted=1` in SQLite once). Expect: "typing…" then a reply. Non-allowlisted account gets the rejection.

- [ ] **Step 7: Commit**

```bash
git add src/agent/dispatch.ts src/index.ts tests/agent/dispatch.test.ts
git commit -m "feat: wire reactive path (allowlist, typing, dispatch, entrypoint)"
```

---

## Milestone 2 — Reminders & scheduler

Deliverable: user says "remind me in 10 minutes to X"; a job persists; the scheduler fires it at the right time via a mini agent turn; survives restart.

### Task 11: Jobs repo

**Files:**
- Create: `src/db/jobs.ts`
- Test: `tests/db/jobs.test.ts`

**Interfaces:**
- Consumes: `DB`.
- Produces: `JobType = 'reminder' | 'followup' | 'heartbeat'`; `Job` `{ id, user_id, type, fire_at, payload: Record<string, unknown>, status }`; `addJob(db, { userId, type, fireAt, payload }): number`; `dueJobs(db, now): Job[]` (status pending, `fire_at <= now`, oldest first); `markDone(db, id): void`; `cancelJob(db, id): void`; `pendingJobsByType(db, userId, type): Job[]`; `pendingHeartbeat(db, userId): Job | undefined`.

- [ ] **Step 1: Write the failing test** — `tests/db/jobs.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { addJob, dueJobs, markDone, cancelJob, pendingJobsByType } from '../../src/db/jobs.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
});

describe('jobs repo', () => {
  it('returns only due, pending jobs oldest-first', () => {
    addJob(db, { userId: uid, type: 'reminder', fireAt: 100, payload: { text: 'a' } });
    addJob(db, { userId: uid, type: 'reminder', fireAt: 50, payload: { text: 'b' } });
    addJob(db, { userId: uid, type: 'reminder', fireAt: 999, payload: { text: 'future' } });
    const due = dueJobs(db, 200);
    expect(due.map((j) => j.payload.text)).toEqual(['b', 'a']);
  });

  it('markDone removes from due set', () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} });
    markDone(db, id);
    expect(dueJobs(db, 100)).toEqual([]);
  });

  it('cancelJob removes from due set and pendingJobsByType', () => {
    const id = addJob(db, { userId: uid, type: 'followup', fireAt: 10, payload: {} });
    cancelJob(db, id);
    expect(pendingJobsByType(db, uid, 'followup')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/jobs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/db/jobs.ts`**

```typescript
import type { DB } from './db.js';

export type JobType = 'reminder' | 'followup' | 'heartbeat';

export interface Job {
  id: number;
  user_id: number;
  type: JobType;
  fire_at: number;
  payload: Record<string, unknown>;
  status: 'pending' | 'done' | 'cancelled';
}

interface Row {
  id: number;
  user_id: number;
  type: JobType;
  fire_at: number;
  payload_json: string;
  status: Job['status'];
}

function hydrate(r: Row): Job {
  return { id: r.id, user_id: r.user_id, type: r.type, fire_at: r.fire_at, payload: JSON.parse(r.payload_json), status: r.status };
}

export function addJob(
  db: DB,
  o: { userId: number; type: JobType; fireAt: number; payload: Record<string, unknown> },
): number {
  const info = db
    .prepare('INSERT INTO jobs (user_id, type, fire_at, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(o.userId, o.type, o.fireAt, JSON.stringify(o.payload), Date.now());
  return Number(info.lastInsertRowid);
}

export function dueJobs(db: DB, now: number): Job[] {
  return (db
    .prepare("SELECT * FROM jobs WHERE status='pending' AND fire_at <= ? ORDER BY fire_at ASC, id ASC")
    .all(now) as Row[]).map(hydrate);
}

export function markDone(db: DB, id: number): void {
  db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(id);
}

export function cancelJob(db: DB, id: number): void {
  db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(id);
}

export function pendingJobsByType(db: DB, userId: number, type: JobType): Job[] {
  return (db
    .prepare("SELECT * FROM jobs WHERE user_id=? AND type=? AND status='pending' ORDER BY fire_at ASC")
    .all(userId, type) as Row[]).map(hydrate);
}

export function pendingHeartbeat(db: DB, userId: number): Job | undefined {
  const r = db
    .prepare("SELECT * FROM jobs WHERE user_id=? AND type='heartbeat' AND status='pending' LIMIT 1")
    .get(userId) as Row | undefined;
  return r ? hydrate(r) : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/jobs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/jobs.ts tests/db/jobs.test.ts
git commit -m "feat: jobs repo"
```

---

### Task 12: `remind` tool + tool assembly

**Files:**
- Create: `src/agent/tools/remind.ts`, `src/agent/tools/index.ts`
- Test: `tests/agent/tools/remind.test.ts`

**Interfaces:**
- Consumes: `addJob` from `db/jobs.ts`, `DB`.
- Produces (`remind.ts`): `makeRemindTool(db, userId): Tool`. AI SDK `tool({ inputSchema: { text: string; delay_minutes: number }, execute })` — computes `fireAt = Date.now() + delay_minutes*60000`, inserts a `reminder` job, returns `{ ok: true, fire_at }`.
- Produces (`index.ts`): `buildToolsFor({ db, userId }): Promise<ToolSet>` returning `{ remind: makeRemindTool(...) }` (grows in later tasks). This is the `buildTools` used in Task 10.

Design note: `delay_minutes` keeps the tool deterministic + unit-testable. The model converts "in 2 weeks" / "next month" into minutes. Absolute-date parsing can be added later; YAGNI for now.

- [ ] **Step 1: Write the failing test** — `tests/agent/tools/remind.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUser } from '../../../src/db/users.js';
import { pendingJobsByType } from '../../../src/db/jobs.js';
import { makeRemindTool } from '../../../src/agent/tools/remind.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
});

describe('remind tool', () => {
  it('schedules a reminder job at now + delay', async () => {
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
    const tool = makeRemindTool(db, uid) as any;
    const res = await tool.execute({ text: 'call mom', delay_minutes: 10 });
    expect(res.ok).toBe(true);
    const jobs = pendingJobsByType(db, uid, 'reminder');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.text).toBe('call mom');
    expect(jobs[0].fire_at).toBe(Date.parse('2026-07-10T00:00:00Z') + 10 * 60000);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tools/remind.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent/tools/remind.ts`**

```typescript
import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import { addJob } from '../../db/jobs.js';

export function makeRemindTool(db: DB, userId: number) {
  return tool({
    description:
      'Schedule a reminder to send back to the user after a delay. Convert any natural-language time (e.g. "in 2 weeks", "next month") into delay_minutes.',
    inputSchema: z.object({
      text: z.string().describe('What to remind the user about'),
      delay_minutes: z.number().int().positive().describe('Minutes from now to fire'),
    }),
    execute: async ({ text, delay_minutes }) => {
      const fireAt = Date.now() + delay_minutes * 60000;
      addJob(db, { userId, type: 'reminder', fireAt, payload: { text } });
      return { ok: true, fire_at: fireAt };
    },
  });
}
```

- [ ] **Step 4: Implement `src/agent/tools/index.ts`**

```typescript
import type { ToolSet } from 'ai';
import type { DB } from '../../db/db.js';
import { makeRemindTool } from './remind.js';

export async function buildToolsFor(opts: { db: DB; userId: number }): Promise<ToolSet> {
  const { db, userId } = opts;
  return {
    remind: makeRemindTool(db, userId),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/agent/tools/remind.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/remind.ts src/agent/tools/index.ts tests/agent/tools/remind.test.ts
git commit -m "feat: remind tool + tool assembly"
```

---

### Task 13: Scheduler (poll + dispatch)

**Files:**
- Create: `src/scheduler/scheduler.ts`
- Test: `tests/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: `dueJobs`, `markDone` from `db/jobs.ts`; `getUserByTelegramId`/user lookup; `ChannelAdapter.send`; `GenerateFn`.
- Produces: `tick(deps, now): Promise<void>` (processes all due jobs once — the unit-testable core) and `startScheduler(deps): { stop(): void }` (calls `tick` every 15s via `setInterval`). `deps = { db; appCfg; adapter: Pick<ChannelAdapter,'send'>; generate: GenerateFn; fireReminder?; fireHeartbeat? }`. `tick` dispatches by job type: `reminder`/`followup` → `fireReminder` (Task 14), `heartbeat` → `fireHeartbeat` (Task 19). Each job wrapped in try/catch so one failure doesn't stop the loop; always `markDone` on success. Needs the user's `telegram_id` to send — look it up by `user_id`.

- [ ] **Step 1: Write the failing test** — `tests/scheduler/scheduler.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { addJob, dueJobs } from '../../src/db/jobs.js';
import { tick } from '../../src/scheduler/scheduler.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 'tg99', heartbeat_interval_min: 30 }).id;
});

function deps(overrides: any = {}) {
  const fired: any[] = [];
  return {
    fired,
    d: {
      db, appCfg: {} as any,
      adapter: { send: async () => {} },
      generate: async () => ({ text: 'x' }),
      fireReminder: async (_d: any, job: any) => { fired.push(['reminder', job.id]); },
      fireHeartbeat: async (_d: any, job: any) => { fired.push(['heartbeat', job.id]); },
      ...overrides,
    },
  };
}

describe('scheduler tick', () => {
  it('dispatches due reminder jobs and marks them done', async () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: { text: 'hi' } });
    const { fired, d } = deps();
    await tick(d as any, 100);
    expect(fired).toEqual([['reminder', id]]);
    expect(dueJobs(db, 100)).toEqual([]); // marked done
  });

  it('does not fire future jobs', async () => {
    addJob(db, { userId: uid, type: 'reminder', fireAt: 5000, payload: {} });
    const { fired, d } = deps();
    await tick(d as any, 100);
    expect(fired).toEqual([]);
  });

  it('a throwing job does not block others and is left pending', async () => {
    const bad = addJob(db, { userId: uid, type: 'reminder', fireAt: 1, payload: { text: 'bad' } });
    const good = addJob(db, { userId: uid, type: 'reminder', fireAt: 2, payload: { text: 'good' } });
    const { fired, d } = deps({
      fireReminder: async (_d: any, job: any) => {
        if (job.id === bad) throw new Error('boom');
        fired.push(job.id);
      },
    });
    await tick(d as any, 100);
    expect(fired).toEqual([good]);
    // bad still pending for retry, good is done
    expect(dueJobs(db, 100).map((j) => j.id)).toEqual([bad]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scheduler/scheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/scheduler/scheduler.ts`**

```typescript
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import type { ChannelAdapter } from '../channels/adapter.js';
import type { GenerateFn } from '../agent/core.js';
import { dueJobs, markDone, type Job } from '../db/jobs.js';

export interface SchedulerDeps {
  db: DB;
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>;
  adapter: Pick<ChannelAdapter, 'send'>;
  generate: GenerateFn;
  fireReminder: (deps: SchedulerDeps, job: Job) => Promise<void>;
  fireHeartbeat: (deps: SchedulerDeps, job: Job) => Promise<void>;
}

const POLL_MS = 15000;

export async function tick(deps: SchedulerDeps, now: number): Promise<void> {
  for (const job of dueJobs(deps.db, now)) {
    try {
      if (job.type === 'heartbeat') {
        await deps.fireHeartbeat(deps, job);
      } else {
        await deps.fireReminder(deps, job);
      }
      markDone(deps.db, job.id);
    } catch (err) {
      console.error(`job ${job.id} (${job.type}) failed:`, err);
      // left pending → retried next tick
    }
  }
}

export function startScheduler(deps: SchedulerDeps): { stop(): void } {
  const timer = setInterval(() => {
    void tick(deps, Date.now());
  }, POLL_MS);
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scheduler/scheduler.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scheduler.ts tests/scheduler/scheduler.test.ts
git commit -m "feat: scheduler tick + poll loop with per-job isolation"
```

---

### Task 14: Fire reminders via mini agent turn

**Files:**
- Create: `src/scheduler/fire.ts`
- Test: `tests/scheduler/fire.test.ts`

**Interfaces:**
- Consumes: `SchedulerDeps`, `Job`, `resolveModels`, `getUserByTelegramId`-style lookup by id, `addMessage`, `ChannelAdapter.send`, `GenerateFn`.
- Produces: `fireReminder(deps, job): Promise<void>` — loads the user (by `job.user_id`), runs a **mini agent turn** on the cheap model to phrase the reminder naturally from `job.payload.text`, persists the assistant message, and sends it via the adapter to the user's `telegram_id`. Export a `getUserById(db, id): User | undefined` helper (add to `db/users.ts`).

- [ ] **Step 1: Add `getUserById` to `src/db/users.ts`**

```typescript
export function getUserById(db: DB, id: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}
```

- [ ] **Step 2: Write the failing test** — `tests/scheduler/fire.test.ts`

```typescript
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { setOpenrouterKey } from '../../src/db/config.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { recentMessages } from '../../src/db/messages.js';
import { fireReminder } from '../../src/scheduler/fire.js';

let db: DB, uid: number;
const sent: any[] = [];
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 'chat55', heartbeat_interval_min: 30 }).id;
  setOpenrouterKey(db, uid, 'sk-or');
  sent.length = 0;
});

describe('fireReminder', () => {
  it('phrases via cheap model and sends to the user chat', async () => {
    const deps: any = {
      db, appCfg: {},
      adapter: { send: async (id: string, text: string) => { sent.push([id, text]); } },
      generate: async (args: any) => {
        expect(JSON.stringify(args.messages)).toContain('buy milk');
        return { text: 'Reminder: buy milk 🥛' };
      },
    };
    await fireReminder(deps, { id: 1, user_id: uid, type: 'reminder', fire_at: 0, payload: { text: 'buy milk' }, status: 'pending' });
    expect(sent).toEqual([['chat55', 'Reminder: buy milk 🥛']]);
    expect(recentMessages(db, uid, 5).at(-1)?.content).toBe('Reminder: buy milk 🥛');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/scheduler/fire.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/scheduler/fire.ts`**

```typescript
import type { Job } from '../db/jobs.js';
import type { SchedulerDeps } from './scheduler.js';
import { getUserById } from '../db/users.js';
import { resolveModels } from '../agent/models.js';
import { addMessage } from '../db/messages.js';

const REMINDER_SYSTEM =
  'You are a personal assistant delivering a scheduled reminder. Phrase it warmly and briefly in one short message. Do not add unrelated content.';

export async function fireReminder(deps: SchedulerDeps, job: Job): Promise<void> {
  const user = getUserById(deps.db, job.user_id);
  if (!user || !user.telegram_id) return;
  const text = String(job.payload.text ?? 'your reminder');
  const models = resolveModels(deps.db, deps.appCfg, user.id);
  const result = await deps.generate({
    model: models.cheap,
    system: REMINDER_SYSTEM,
    messages: [{ role: 'user', content: `Deliver this reminder to the user: "${text}"` }],
  });
  addMessage(deps.db, user.id, 'assistant', result.text);
  await deps.adapter.send(user.telegram_id, result.text);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/scheduler/fire.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire `fireReminder` into the scheduler in `src/index.ts`**

Update the `startScheduler` call:

```typescript
import { startScheduler } from './scheduler/scheduler.js';
import { fireReminder } from './scheduler/fire.js';
import { fireHeartbeat } from './scheduler/heartbeat.js'; // Task 19
// ...
startScheduler({ db, appCfg, adapter, generate, fireReminder, fireHeartbeat });
```

(Until Task 19, pass a temporary `fireHeartbeat: async () => {}` stub.)

- [ ] **Step 7: Commit**

```bash
git add src/db/users.ts src/scheduler/fire.ts tests/scheduler/fire.test.ts src/index.ts
git commit -m "feat: fire reminders via mini agent turn"
```

---

## Milestone 3 — Memory, follow-ups, summarization, heartbeat

Deliverable: agent remembers facts; can track a task and follow up; long histories compact; a periodic heartbeat autonomously decides whether to ping the user, respecting quiet hours.

### Task 15: Memory repo

**Files:**
- Create: `src/db/memory.ts`
- Test: `tests/db/memory.test.ts`

**Interfaces:**
- Consumes: `DB`.
- Produces: `MemoryItem` `{ id, user_id, mkey, text, created_at }`; `remember(db, userId, text, mkey?): number`; `recall(db, userId, query?): MemoryItem[]` (if `query` given, case-insensitive LIKE on text; else all, newest first, capped 50); `forget(db, id): void`.

- [ ] **Step 1: Write the failing test** — `tests/db/memory.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { remember, recall, forget } from '../../src/db/memory.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
});

describe('memory repo', () => {
  it('remembers and recalls all newest-first', () => {
    remember(db, uid, 'likes coffee');
    remember(db, uid, 'wife name is Dana');
    expect(recall(db, uid).map((m) => m.text)).toEqual(['wife name is Dana', 'likes coffee']);
  });

  it('recall filters by query', () => {
    remember(db, uid, 'likes coffee');
    remember(db, uid, 'allergic to peanuts');
    expect(recall(db, uid, 'coffee').map((m) => m.text)).toEqual(['likes coffee']);
  });

  it('forget removes an item', () => {
    const id = remember(db, uid, 'temp');
    forget(db, id);
    expect(recall(db, uid)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/memory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/db/memory.ts`**

```typescript
import type { DB } from './db.js';

export interface MemoryItem {
  id: number;
  user_id: number;
  mkey: string | null;
  text: string;
  created_at: number;
}

export function remember(db: DB, userId: number, text: string, mkey?: string): number {
  const info = db
    .prepare('INSERT INTO memory (user_id, mkey, text, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, mkey ?? null, text, Date.now());
  return Number(info.lastInsertRowid);
}

export function recall(db: DB, userId: number, query?: string): MemoryItem[] {
  if (query) {
    return db
      .prepare('SELECT * FROM memory WHERE user_id = ? AND text LIKE ? ORDER BY id DESC LIMIT 50')
      .all(userId, `%${query}%`) as MemoryItem[];
  }
  return db
    .prepare('SELECT * FROM memory WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .all(userId) as MemoryItem[];
}

export function forget(db: DB, id: number): void {
  db.prepare('DELETE FROM memory WHERE id = ?').run(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/memory.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/memory.ts tests/db/memory.test.ts
git commit -m "feat: memory repo"
```

---

### Task 16: memory + track tools

**Files:**
- Create: `src/agent/tools/memory.ts`, `src/agent/tools/track.ts`
- Modify: `src/agent/tools/index.ts`
- Test: `tests/agent/tools/memory.test.ts`, `tests/agent/tools/track.test.ts`

**Interfaces:**
- Produces (`memory.ts`): `makeRememberTool(db, userId)` (`inputSchema {text, key?}` → `remember`); `makeRecallTool(db, userId)` (`inputSchema {query?}` → returns `{items: string[]}`).
- Produces (`track.ts`): `makeTrackTool(db, userId)` — `inputSchema {task: string, check_in_minutes: number}` → stores a memory note ("tracking: <task>") AND schedules a `followup` job with payload `{ task }` at `now + check_in_minutes*60000`. Returns `{ ok: true }`.
- Modify `index.ts`: add `remember`, `recall`, `track` to the returned `ToolSet`.

- [ ] **Step 1: Write the failing tests**

`tests/agent/tools/memory.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUser } from '../../../src/db/users.js';
import { recall } from '../../../src/db/memory.js';
import { makeRememberTool, makeRecallTool } from '../../../src/agent/tools/memory.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
});

describe('memory tools', () => {
  it('remember tool stores a fact', async () => {
    await (makeRememberTool(db, uid) as any).execute({ text: 'drinks tea' });
    expect(recall(db, uid).map((m) => m.text)).toContain('drinks tea');
  });
  it('recall tool returns items array', async () => {
    await (makeRememberTool(db, uid) as any).execute({ text: 'plays guitar' });
    const res = await (makeRecallTool(db, uid) as any).execute({ query: 'guitar' });
    expect(res.items).toEqual(['plays guitar']);
  });
});
```

`tests/agent/tools/track.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUser } from '../../../src/db/users.js';
import { pendingJobsByType } from '../../../src/db/jobs.js';
import { recall } from '../../../src/db/memory.js';
import { makeTrackTool } from '../../../src/agent/tools/track.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
});

describe('track tool', () => {
  it('records a note and schedules a followup', async () => {
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
    await (makeTrackTool(db, uid) as any).execute({ task: 'submit tax form', check_in_minutes: 60 });
    expect(recall(db, uid).some((m) => m.text.includes('submit tax form'))).toBe(true);
    const jobs = pendingJobsByType(db, uid, 'followup');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.task).toBe('submit tax form');
    expect(jobs[0].fire_at).toBe(Date.parse('2026-07-10T00:00:00Z') + 60 * 60000);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/tools/memory.test.ts tests/agent/tools/track.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/agent/tools/memory.ts`**

```typescript
import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import { remember, recall } from '../../db/memory.js';

export function makeRememberTool(db: DB, userId: number) {
  return tool({
    description: 'Store a durable fact about the user for future conversations.',
    inputSchema: z.object({
      text: z.string().describe('The fact to remember'),
      key: z.string().optional().describe('Optional short label'),
    }),
    execute: async ({ text, key }) => {
      remember(db, userId, text, key);
      return { ok: true };
    },
  });
}

export function makeRecallTool(db: DB, userId: number) {
  return tool({
    description: 'Recall stored facts about the user. Optionally filter by a query.',
    inputSchema: z.object({
      query: z.string().optional().describe('Substring filter; omit to list recent facts'),
    }),
    execute: async ({ query }) => ({ items: recall(db, userId, query).map((m) => m.text) }),
  });
}
```

- [ ] **Step 4: Implement `src/agent/tools/track.ts`**

```typescript
import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import { remember } from '../../db/memory.js';
import { addJob } from '../../db/jobs.js';

export function makeTrackTool(db: DB, userId: number) {
  return tool({
    description:
      'Track a task the user wants to do and follow up later to check if they did it. Convert the check-in time into minutes.',
    inputSchema: z.object({
      task: z.string().describe('The task to track'),
      check_in_minutes: z.number().int().positive().describe('When to follow up, in minutes'),
    }),
    execute: async ({ task, check_in_minutes }) => {
      remember(db, userId, `tracking: ${task}`, 'tracked-task');
      addJob(db, {
        userId,
        type: 'followup',
        fireAt: Date.now() + check_in_minutes * 60000,
        payload: { task },
      });
      return { ok: true };
    },
  });
}
```

- [ ] **Step 5: Modify `src/agent/tools/index.ts`**

```typescript
import type { ToolSet } from 'ai';
import type { DB } from '../../db/db.js';
import { makeRemindTool } from './remind.js';
import { makeRememberTool, makeRecallTool } from './memory.js';
import { makeTrackTool } from './track.js';

export async function buildToolsFor(opts: { db: DB; userId: number }): Promise<ToolSet> {
  const { db, userId } = opts;
  return {
    remind: makeRemindTool(db, userId),
    remember: makeRememberTool(db, userId),
    recall: makeRecallTool(db, userId),
    track: makeTrackTool(db, userId),
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/agent/tools/`
Expected: PASS (all tool tests).

- [ ] **Step 7: Commit**

```bash
git add src/agent/tools/memory.ts src/agent/tools/track.ts src/agent/tools/index.ts tests/agent/tools/memory.test.ts tests/agent/tools/track.test.ts
git commit -m "feat: memory + track tools"
```

Note: `followup` jobs are fired by `fireReminder` (Task 14) — the scheduler routes both `reminder` and `followup` there. Follow-ups carry `payload.task`; extend `fireReminder` to accept either `payload.text` or `payload.task`:

- [ ] **Step 8: Extend `fireReminder` for follow-ups** in `src/scheduler/fire.ts`

Change the text extraction line to:

```typescript
const text = String(job.payload.text ?? job.payload.task ?? 'your reminder');
const system = job.type === 'followup'
  ? 'You are a personal assistant following up on a task the user meant to do. Ask, warmly and briefly, whether they did it.'
  : REMINDER_SYSTEM;
```

and pass `system` to `generate`. Add a test case in `tests/scheduler/fire.test.ts` for a `followup` job asserting the follow-up phrasing path runs (model receives the task text). Commit:

```bash
git add src/scheduler/fire.ts tests/scheduler/fire.test.ts
git commit -m "feat: fire follow-up check-ins"
```

---

### Task 17: History builder + rolling summarization

**Files:**
- Create: `src/agent/summarize.ts`, `src/agent/history.ts`
- Test: `tests/agent/summarize.test.ts`

**Interfaces:**
- Consumes: `DB`, `messagesSince`/`recentMessages`, `resolveModels`, `GenerateFn`.
- Produces (`summarize.ts`): `maybeSummarize(deps, userId): Promise<void>` — if unsummarized message count (id > `summaries.last_summarized_msg_id`) exceeds `SUMMARY_TRIGGER` (30), fold the older half into `summaries.summary` via the cheap model, advance `last_summarized_msg_id`. Helpers `getSummary(db, userId): { summary, last_summarized_msg_id }`.
- Produces (`history.ts`): `buildContext(db, userId, recentLimit): { system?: string; messages: CoreMessage[] }` — prepends the stored summary (if any) as a system note, then the recent verbatim messages.

Design note: for MVP, `runAgentTurn` keeps using `recentMessages` (Task 8). This task adds summarization invoked opportunistically after each turn and exposes `buildContext` for the heartbeat (Task 19). Wiring `buildContext` into `runAgentTurn` is a small follow-up in Step 6.

- [ ] **Step 1: Write the failing test** — `tests/agent/summarize.test.ts`

```typescript
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { setOpenrouterKey } from '../../src/db/config.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { addMessage } from '../../src/db/messages.js';
import { maybeSummarize, getSummary } from '../../src/agent/summarize.js';

let db: DB, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
  setOpenrouterKey(db, uid, 'sk-or');
});

describe('maybeSummarize', () => {
  it('does nothing below the trigger threshold', async () => {
    for (let i = 0; i < 5; i++) addMessage(db, uid, 'user', `m${i}`);
    let called = false;
    await maybeSummarize({ db, appCfg: {} as any, generate: async () => { called = true; return { text: 's' }; } }, uid);
    expect(called).toBe(false);
    expect(getSummary(db, uid).summary).toBe('');
  });

  it('summarizes older half once over threshold and advances pointer', async () => {
    for (let i = 0; i < 40; i++) addMessage(db, uid, 'user', `m${i}`);
    await maybeSummarize({ db, appCfg: {} as any, generate: async () => ({ text: 'SUMMARY' }) }, uid);
    const s = getSummary(db, uid);
    expect(s.summary).toContain('SUMMARY');
    expect(s.last_summarized_msg_id).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/summarize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent/summarize.ts`**

```typescript
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import type { GenerateFn } from './core.js';
import { resolveModels } from './models.js';

const SUMMARY_TRIGGER = 30;

export interface SummarizeDeps {
  db: DB;
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>;
  generate: GenerateFn;
}

export function getSummary(db: DB, userId: number): { summary: string; last_summarized_msg_id: number } {
  const row = db.prepare('SELECT summary, last_summarized_msg_id FROM summaries WHERE user_id = ?').get(userId) as
    | { summary: string; last_summarized_msg_id: number }
    | undefined;
  return row ?? { summary: '', last_summarized_msg_id: 0 };
}

export async function maybeSummarize(deps: SummarizeDeps, userId: number): Promise<void> {
  const { db } = deps;
  const { summary, last_summarized_msg_id } = getSummary(db, userId);
  const unsummarized = db
    .prepare('SELECT * FROM messages WHERE user_id = ? AND id > ? ORDER BY id ASC')
    .all(userId, last_summarized_msg_id) as { id: number; role: string; content: string }[];
  if (unsummarized.length <= SUMMARY_TRIGGER) return;

  const half = Math.floor(unsummarized.length / 2);
  const toFold = unsummarized.slice(0, half);
  const transcript = toFold.map((m) => `${m.role}: ${m.content}`).join('\n');
  const models = resolveModels(db, deps.appCfg, userId);
  const result = await deps.generate({
    model: models.cheap,
    system:
      'Update the running summary of this conversation. Keep durable facts, ongoing tasks, and context. Be concise.',
    messages: [
      { role: 'user', content: `Existing summary:\n${summary || '(none)'}\n\nNew messages to fold in:\n${transcript}` },
    ],
  });
  const newPointer = toFold[toFold.length - 1]!.id;
  db.prepare(
    `INSERT INTO summaries (user_id, summary, last_summarized_msg_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET summary = excluded.summary, last_summarized_msg_id = excluded.last_summarized_msg_id`,
  ).run(userId, result.text, newPointer);
}
```

- [ ] **Step 4: Implement `src/agent/history.ts`**

```typescript
import type { CoreMessage } from 'ai';
import type { DB } from '../db/db.js';
import { recentMessages } from '../db/messages.js';
import { getSummary } from './summarize.js';

export function buildContext(
  db: DB,
  userId: number,
  recentLimit: number,
): { system?: string; messages: CoreMessage[] } {
  const { summary } = getSummary(db, userId);
  const msgs = recentMessages(db, userId, recentLimit).map((m) => ({
    role: m.role === 'system' ? 'system' : m.role,
    content: m.content,
  })) as CoreMessage[];
  return {
    system: summary ? `Conversation summary so far:\n${summary}` : undefined,
    messages: msgs,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/agent/summarize.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Invoke summarization after each turn**

In `src/agent/dispatch.ts`, after a successful `runTurn`, call `maybeSummarize` (fire-and-forget, wrapped in try/catch so it never breaks a reply). Add `maybeSummarize` to `DispatchDeps` for testability, defaulting to the real impl in `index.ts`. Add a test asserting it's invoked. Commit together.

- [ ] **Step 7: Commit**

```bash
git add src/agent/summarize.ts src/agent/history.ts src/agent/dispatch.ts tests/agent/summarize.test.ts tests/agent/dispatch.test.ts
git commit -m "feat: rolling summarization + context builder"
```

---

### Task 18: Quiet hours helper

**Files:**
- Create: `src/scheduler/quiet.ts`
- Test: `tests/scheduler/quiet.test.ts`

**Interfaces:**
- Produces: `isQuiet(user: Pick<User,'tz'|'quiet_start'|'quiet_end'>, atMs: number): boolean` — computes the local hour in the user's `tz` (via `Intl.DateTimeFormat` with `timeZone`) and returns whether it falls in the quiet window. Handles wrap-around (e.g. 22→8).

- [ ] **Step 1: Write the failing test** — `tests/scheduler/quiet.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { isQuiet } from '../../src/scheduler/quiet.js';

const u = { tz: 'UTC', quiet_start: 22, quiet_end: 8 };

describe('isQuiet', () => {
  it('true at 23:00 UTC (inside 22-8 wrap window)', () => {
    expect(isQuiet(u, Date.parse('2026-07-10T23:00:00Z'))).toBe(true);
  });
  it('true at 03:00 UTC', () => {
    expect(isQuiet(u, Date.parse('2026-07-10T03:00:00Z'))).toBe(true);
  });
  it('false at 12:00 UTC', () => {
    expect(isQuiet(u, Date.parse('2026-07-10T12:00:00Z'))).toBe(false);
  });
  it('respects timezone', () => {
    // 12:00 UTC == 15:00 Asia/Jerusalem (summer, UTC+3) → awake
    expect(isQuiet({ tz: 'Asia/Jerusalem', quiet_start: 22, quiet_end: 8 }, Date.parse('2026-07-10T12:00:00Z'))).toBe(false);
    // 02:00 UTC == 05:00 Jerusalem → quiet
    expect(isQuiet({ tz: 'Asia/Jerusalem', quiet_start: 22, quiet_end: 8 }, Date.parse('2026-07-10T02:00:00Z'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scheduler/quiet.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/scheduler/quiet.ts`**

```typescript
export interface QuietWindow {
  tz: string;
  quiet_start: number;
  quiet_end: number;
}

export function isQuiet(u: QuietWindow, atMs: number): boolean {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: u.tz,
    hour: 'numeric',
    hour12: false,
  }).format(new Date(atMs));
  // "24" can appear for midnight in some environments; normalize to 0
  const hour = Number(hourStr) % 24;
  const { quiet_start: s, quiet_end: e } = u;
  if (s === e) return false;
  if (s < e) return hour >= s && hour < e;
  return hour >= s || hour < e; // wrap-around
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scheduler/quiet.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/quiet.ts tests/scheduler/quiet.test.ts
git commit -m "feat: quiet-hours helper (tz-aware, wrap-around)"
```

---

### Task 19: Heartbeat gate + self-scheduling

**Files:**
- Create: `src/scheduler/heartbeat.ts`
- Modify: `src/index.ts` (seed heartbeat jobs on boot)
- Test: `tests/scheduler/heartbeat.test.ts`

**Interfaces:**
- Consumes: `SchedulerDeps`, `Job`, `getUserById`, `resolveModels`, `buildContext`, `recall`, `isQuiet`, `addJob`, `addMessage`, `GenerateFn` (with structured decision).
- Produces:
  - `fireHeartbeat(deps, job): Promise<void>` — the heartbeat tick body. Steps: (1) reschedule the next heartbeat job (`addJob type=heartbeat fireAt=now+interval`). (2) If `isQuiet` → return (silent). (3) Build gate input from memory + recent context + current time; ask the **cheap model** via `deps.decideHeartbeat` returning `{ act: boolean; message?: string }`. (4) If `act && message` → persist + send to the user. Escalation to the strong model for composing a richer message is done inside `decideHeartbeat` when `act` is true.
  - `decideHeartbeat(deps, userId): Promise<{ act: boolean; message?: string }>` — default impl uses `generateObject`-style structured output; injectable for tests.
  - `seedHeartbeats(db, appCfg): void` — for each allowlisted user with no pending heartbeat job, schedule one at `now + interval`.

- [ ] **Step 1: Write the failing test** — `tests/scheduler/heartbeat.test.ts`

```typescript
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser, setAllowlisted } from '../../src/db/users.js';
import { setOpenrouterKey } from '../../src/db/config.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { pendingHeartbeat } from '../../src/db/jobs.js';
import { recentMessages } from '../../src/db/messages.js';
import { fireHeartbeat, seedHeartbeats } from '../../src/scheduler/heartbeat.js';

let db: DB, uid: number;
const sent: any[] = [];
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  const u = createUser(db, { telegram_id: 'hb1', heartbeat_interval_min: 30 });
  uid = u.id;
  setAllowlisted(db, uid, true);
  setOpenrouterKey(db, uid, 'sk-or');
  sent.length = 0;
  // ensure not quiet: force tz where it's daytime
  db.prepare('UPDATE users SET tz=?, quiet_start=?, quiet_end=? WHERE id=?').run('UTC', 0, 0, uid);
});

function deps(decision: any) {
  return {
    db, appCfg: {} as any,
    adapter: { send: async (id: string, t: string) => { sent.push([id, t]); } },
    generate: async () => ({ text: '' }),
    decideHeartbeat: async () => decision,
  } as any;
}

const job = () => ({ id: 1, user_id: uid, type: 'heartbeat' as const, fire_at: 0, payload: {}, status: 'pending' as const });

describe('heartbeat', () => {
  it('reschedules the next heartbeat every fire', async () => {
    await fireHeartbeat(deps({ act: false }), job());
    expect(pendingHeartbeat(db, uid)).toBeDefined();
  });

  it('stays silent when gate says no', async () => {
    await fireHeartbeat(deps({ act: false }), job());
    expect(sent).toEqual([]);
  });

  it('messages the user when gate says act', async () => {
    await fireHeartbeat(deps({ act: true, message: 'Did you call the dentist?' }), job());
    expect(sent).toEqual([['hb1', 'Did you call the dentist?']]);
    expect(recentMessages(db, uid, 5).at(-1)?.content).toBe('Did you call the dentist?');
  });

  it('stays silent during quiet hours even if gate would act', async () => {
    db.prepare('UPDATE users SET quiet_start=0, quiet_end=24 WHERE id=?').run(uid); // always quiet
    await fireHeartbeat(deps({ act: true, message: 'ping' }), job());
    expect(sent).toEqual([]);
  });

  it('seedHeartbeats schedules one per allowlisted user without a pending heartbeat', () => {
    seedHeartbeats(db, {} as any);
    expect(pendingHeartbeat(db, uid)).toBeDefined();
    seedHeartbeats(db, {} as any); // idempotent
    expect(db.prepare("SELECT COUNT(*) c FROM jobs WHERE type='heartbeat' AND status='pending'").get()).toEqual({ c: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scheduler/heartbeat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/scheduler/heartbeat.ts`**

```typescript
import { z } from 'zod';
import { generateObject } from 'ai';
import type { Job } from '../db/jobs.js';
import type { SchedulerDeps } from './scheduler.js';
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { getUserById, listAllowlisted } from '../db/users.js';
import { addJob, pendingHeartbeat } from '../db/jobs.js';
import { addMessage } from '../db/messages.js';
import { recall } from '../db/memory.js';
import { buildContext } from '../agent/history.js';
import { resolveModels } from '../agent/models.js';
import { isQuiet } from './quiet.js';

export interface HeartbeatDeps extends SchedulerDeps {
  decideHeartbeat?: (deps: HeartbeatDeps, userId: number) => Promise<{ act: boolean; message?: string }>;
}

const GATE_SYSTEM =
  'You are a proactive personal assistant. Given the user\'s memory, tracked tasks, recent conversation, and the current time, decide whether there is something worth proactively messaging them about right now (an overdue tracked task, a timely nudge, a relevant follow-up). Only act if it genuinely adds value; prefer silence. If you act, write the exact short message to send.';

export async function decideHeartbeat(
  deps: HeartbeatDeps,
  userId: number,
): Promise<{ act: boolean; message?: string }> {
  const models = resolveModels(deps.db, deps.appCfg, userId);
  const ctx = buildContext(deps.db, userId, 15);
  const facts = recall(deps.db, userId).map((m) => m.text).join('\n');
  const nowIso = new Date(Date.now()).toISOString();
  const { object } = await generateObject({
    model: models.cheap,
    schema: z.object({ act: z.boolean(), message: z.string().optional() }),
    system: GATE_SYSTEM,
    prompt: `Current time (UTC): ${nowIso}\n\nMemory/facts:\n${facts || '(none)'}\n\nConversation summary:\n${ctx.system ?? '(none)'}\n\nRecent messages:\n${ctx.messages.map((m) => `${m.role}: ${m.content}`).join('\n') || '(none)'}`,
  });
  return object;
}

export async function fireHeartbeat(deps: HeartbeatDeps, job: Job): Promise<void> {
  const user = getUserById(deps.db, job.user_id);
  if (!user || !user.telegram_id) return;

  // 1. Always reschedule next tick first.
  addJob(deps.db, {
    userId: user.id,
    type: 'heartbeat',
    fireAt: Date.now() + user.heartbeat_interval_min * 60000,
    payload: {},
  });

  // 2. Quiet hours → silent.
  if (isQuiet(user, Date.now())) return;

  // 3. Gate decision.
  const decide = deps.decideHeartbeat ?? decideHeartbeat;
  const decision = await decide(deps, user.id);

  // 4. Act.
  if (decision.act && decision.message) {
    addMessage(deps.db, user.id, 'assistant', decision.message);
    await deps.adapter.send(user.telegram_id, decision.message);
  }
}

export function seedHeartbeats(db: DB, _appCfg: Pick<AppConfig, 'openrouterKeyFallback'>): void {
  for (const u of listAllowlisted(db)) {
    if (!pendingHeartbeat(db, u.id)) {
      addJob(db, {
        userId: u.id,
        type: 'heartbeat',
        fireAt: Date.now() + u.heartbeat_interval_min * 60000,
        payload: {},
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scheduler/heartbeat.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire into `src/index.ts`**

Import `fireHeartbeat`, `seedHeartbeats`; pass real `fireHeartbeat` to `startScheduler`; call `seedHeartbeats(db, appCfg)` on boot; also call `seedHeartbeats` whenever a user is newly allowlisted (via the web UI, Task 25) — or rely on boot + next restart. For MVP, seed on boot.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/heartbeat.ts src/index.ts tests/scheduler/heartbeat.test.ts
git commit -m "feat: heartbeat gate, quiet hours, self-rescheduling"
```

---

## Milestone 4 — MCP support

Deliverable: a user can register an MCP server; its tools appear in the agent's toolset; a down server degrades gracefully.

### Task 20: mcp_servers repo

**Files:**
- Create: `src/db/mcp.ts`
- Test: `tests/db/mcp.test.ts`

**Interfaces:**
- Consumes: `DB`, `encrypt`/`decrypt`.
- Produces: `McpServer` `{ id, user_id, name, transport: 'stdio'|'http'|'sse', command?, args: string[], url?, creds?: Record<string,string>, enabled: boolean }`; `addMcpServer(db, userId, input): number` (encrypts `creds`); `listMcpServers(db, userId): McpServer[]` (decrypts creds); `listEnabledMcpServers(db, userId): McpServer[]`; `setMcpEnabled(db, id, on): void`; `deleteMcpServer(db, id): void`.

- [ ] **Step 1: Write the failing test** — `tests/db/mcp.test.ts`

```typescript
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { addMcpServer, listMcpServers, listEnabledMcpServers, setMcpEnabled, deleteMcpServer } from '../../src/db/mcp.js';

let db: DB, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
});

describe('mcp repo', () => {
  it('stores + reads http server with encrypted creds', () => {
    addMcpServer(db, uid, { name: 'gh', transport: 'http', url: 'https://x/mcp', creds: { Authorization: 'Bearer z' }, args: [] });
    const raw = db.prepare('SELECT creds_enc FROM mcp_servers').get() as any;
    expect(raw.creds_enc).not.toContain('Bearer z');
    const list = listMcpServers(db, uid);
    expect(list[0].creds).toEqual({ Authorization: 'Bearer z' });
    expect(list[0].transport).toBe('http');
  });

  it('enable/disable + listEnabled', () => {
    const id = addMcpServer(db, uid, { name: 's', transport: 'stdio', command: 'node', args: ['x.js'] });
    setMcpEnabled(db, id, false);
    expect(listEnabledMcpServers(db, uid)).toEqual([]);
    setMcpEnabled(db, id, true);
    expect(listEnabledMcpServers(db, uid)).toHaveLength(1);
  });

  it('delete', () => {
    const id = addMcpServer(db, uid, { name: 's', transport: 'stdio', command: 'node', args: [] });
    deleteMcpServer(db, id);
    expect(listMcpServers(db, uid)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/mcp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/db/mcp.ts`**

```typescript
import type { DB } from './db.js';
import { encrypt, decrypt } from '../crypto/encryption.js';

export type McpTransport = 'stdio' | 'http' | 'sse';
export interface McpServer {
  id: number;
  user_id: number;
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  creds?: Record<string, string>;
  enabled: boolean;
}

export interface McpInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  creds?: Record<string, string>;
}

interface Row {
  id: number;
  user_id: number;
  name: string;
  transport: McpTransport;
  command: string | null;
  args_json: string;
  url: string | null;
  creds_enc: string | null;
  enabled: number;
}

function hydrate(r: Row): McpServer {
  return {
    id: r.id,
    user_id: r.user_id,
    name: r.name,
    transport: r.transport,
    command: r.command ?? undefined,
    args: JSON.parse(r.args_json),
    url: r.url ?? undefined,
    creds: r.creds_enc ? JSON.parse(decrypt(r.creds_enc)) : undefined,
    enabled: r.enabled === 1,
  };
}

export function addMcpServer(db: DB, userId: number, input: McpInput): number {
  const credsEnc = input.creds ? encrypt(JSON.stringify(input.creds)) : null;
  const info = db
    .prepare(
      'INSERT INTO mcp_servers (user_id, name, transport, command, args_json, url, creds_enc, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    )
    .run(userId, input.name, input.transport, input.command ?? null, JSON.stringify(input.args), input.url ?? null, credsEnc);
  return Number(info.lastInsertRowid);
}

export function listMcpServers(db: DB, userId: number): McpServer[] {
  return (db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY id').all(userId) as Row[]).map(hydrate);
}

export function listEnabledMcpServers(db: DB, userId: number): McpServer[] {
  return (db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? AND enabled = 1 ORDER BY id').all(userId) as Row[]).map(hydrate);
}

export function setMcpEnabled(db: DB, id: number, on: boolean): void {
  db.prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(on ? 1 : 0, id);
}

export function deleteMcpServer(db: DB, id: number): void {
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/mcp.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/mcp.ts tests/db/mcp.test.ts
git commit -m "feat: mcp_servers repo with encrypted creds"
```

---

### Task 21: MCP manager (tool assembly + graceful failure)

**Files:**
- Create: `src/mcp/manager.ts`
- Test: `tests/mcp/manager.test.ts`

**Interfaces:**
- Consumes: `listEnabledMcpServers`, `DB`, `@ai-sdk/mcp` `createMCPClient` + `StdioClientTransport`.
- Produces: `assembleMcpTools(deps, userId): Promise<{ tools: ToolSet; closeAll: () => Promise<void> }>` where `deps = { db; makeClient?: (server: McpServer) => Promise<McpClientLike> }`. For each enabled server, create a client, call `.tools()`, merge into a `ToolSet` keyed as `${server.name}__${toolName}`. If a server throws, log + skip it (never throw). `closeAll` closes every opened client. `McpClientLike = { tools(): Promise<ToolSet>; close(): Promise<void> }`.

- [ ] **Step 1: Write the failing test** — `tests/mcp/manager.test.ts`

```typescript
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { addMcpServer } from '../../src/db/mcp.js';
import { assembleMcpTools } from '../../src/mcp/manager.js';

let db: DB, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
});

describe('assembleMcpTools', () => {
  it('namespaces tools by server name and closes all', async () => {
    addMcpServer(db, uid, { name: 'weather', transport: 'http', url: 'http://x', args: [] });
    let closed = 0;
    const makeClient = async () => ({
      tools: async () => ({ forecast: { description: 'f' } as any }),
      close: async () => { closed++; },
    });
    const { tools, closeAll } = await assembleMcpTools({ db, makeClient }, uid);
    expect(Object.keys(tools)).toEqual(['weather__forecast']);
    await closeAll();
    expect(closed).toBe(1);
  });

  it('skips a failing server without throwing', async () => {
    addMcpServer(db, uid, { name: 'bad', transport: 'http', url: 'http://x', args: [] });
    addMcpServer(db, uid, { name: 'good', transport: 'http', url: 'http://y', args: [] });
    const makeClient = async (s: any) => {
      if (s.name === 'bad') throw new Error('down');
      return { tools: async () => ({ ok: { description: 'o' } as any }), close: async () => {} };
    };
    const { tools } = await assembleMcpTools({ db, makeClient }, uid);
    expect(Object.keys(tools)).toEqual(['good__ok']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/manager.ts`**

```typescript
import type { ToolSet } from 'ai';
import { createMCPClient } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@ai-sdk/mcp';
import type { DB } from '../db/db.js';
import { listEnabledMcpServers, type McpServer } from '../db/mcp.js';

export interface McpClientLike {
  tools(): Promise<ToolSet>;
  close(): Promise<void>;
}

export interface ManagerDeps {
  db: DB;
  makeClient?: (server: McpServer) => Promise<McpClientLike>;
}

export async function defaultMakeClient(server: McpServer): Promise<McpClientLike> {
  if (server.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: server.command!,
      args: server.args,
      env: server.creds,
    });
    return (await createMCPClient({ transport })) as unknown as McpClientLike;
  }
  // http or sse
  return (await createMCPClient({
    transport: { type: server.transport, url: server.url!, headers: server.creds },
  })) as unknown as McpClientLike;
}

export async function assembleMcpTools(
  deps: ManagerDeps,
  userId: number,
): Promise<{ tools: ToolSet; closeAll: () => Promise<void> }> {
  const make = deps.makeClient ?? defaultMakeClient;
  const clients: McpClientLike[] = [];
  const tools: ToolSet = {};

  for (const server of listEnabledMcpServers(deps.db, userId)) {
    try {
      const client = await make(server);
      clients.push(client);
      const serverTools = await client.tools();
      for (const [toolName, def] of Object.entries(serverTools)) {
        tools[`${server.name}__${toolName}`] = def;
      }
    } catch (err) {
      console.error(`MCP server "${server.name}" unavailable, skipping:`, err);
    }
  }

  return {
    tools,
    closeAll: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/manager.test.ts`
Expected: PASS (2 tests).

Note: verify the exact `@ai-sdk/mcp` export names (`createMCPClient`, `StdioClientTransport`) against the installed version; if the package instead exposes `experimental_createMCPClient` from `ai`, adjust the import in `defaultMakeClient` only — the manager's tested logic is unaffected since `makeClient` is injected in tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/manager.ts tests/mcp/manager.test.ts
git commit -m "feat: per-user MCP tool assembly with graceful degradation"
```

---

### Task 22: Attach MCP tools to the agent turn

**Files:**
- Modify: `src/agent/tools/index.ts`, `src/agent/core.ts`
- Test: `tests/agent/tools/index.test.ts`

**Interfaces:**
- Modify `buildToolsFor` → return `{ tools: ToolSet; closeAll: () => Promise<void> }` (merges built-in tools + `assembleMcpTools`). Injectable `assemble` param for tests defaulting to `assembleMcpTools`.
- Modify `runAgentTurn`: `buildTools` now yields `{ tools, closeAll }`; call `closeAll()` in a `finally`.

- [ ] **Step 1: Write the failing test** — `tests/agent/tools/index.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUser } from '../../../src/db/users.js';
import { buildToolsFor } from '../../../src/agent/tools/index.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
});

describe('buildToolsFor', () => {
  it('merges built-in tools with mcp tools and exposes closeAll', async () => {
    let closed = false;
    const assemble = async () => ({ tools: { ext__x: { description: 'x' } as any }, closeAll: async () => { closed = true; } });
    const { tools, closeAll } = await buildToolsFor({ db, userId: uid, assemble });
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['remind', 'remember', 'recall', 'track', 'ext__x']));
    await closeAll();
    expect(closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tools/index.test.ts`
Expected: FAIL — signature mismatch (`buildToolsFor` returns a bare `ToolSet`).

- [ ] **Step 3: Modify `src/agent/tools/index.ts`**

```typescript
import type { ToolSet } from 'ai';
import type { DB } from '../../db/db.js';
import { makeRemindTool } from './remind.js';
import { makeRememberTool, makeRecallTool } from './memory.js';
import { makeTrackTool } from './track.js';
import { assembleMcpTools } from '../../mcp/manager.js';

export interface BuiltTools {
  tools: ToolSet;
  closeAll: () => Promise<void>;
}

export async function buildToolsFor(opts: {
  db: DB;
  userId: number;
  assemble?: (deps: { db: DB }, userId: number) => Promise<{ tools: ToolSet; closeAll: () => Promise<void> }>;
}): Promise<BuiltTools> {
  const { db, userId } = opts;
  const builtIn: ToolSet = {
    remind: makeRemindTool(db, userId),
    remember: makeRememberTool(db, userId),
    recall: makeRecallTool(db, userId),
    track: makeTrackTool(db, userId),
  };
  const assemble = opts.assemble ?? assembleMcpTools;
  const mcp = await assemble({ db }, userId);
  return {
    tools: { ...builtIn, ...mcp.tools },
    closeAll: mcp.closeAll,
  };
}
```

- [ ] **Step 4: Modify `runAgentTurn` in `src/agent/core.ts`**

Change the `buildTools` type + usage:

```typescript
export interface AgentDeps {
  db: DB;
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>;
  generate: GenerateFn;
  buildTools?: (userId: number) => Promise<{ tools: ToolSet; closeAll: () => Promise<void> }>;
}
```

and in the body:

```typescript
  const built = deps.buildTools ? await deps.buildTools(opts.userId) : undefined;
  try {
    const result = await deps.generate({
      model,
      system: opts.system,
      messages,
      tools: built?.tools,
    });
    addMessage(db, opts.userId, 'assistant', result.text);
    return result.text;
  } finally {
    await built?.closeAll();
  }
```

Update `tests/agent/core.test.ts` if it referenced the old `buildTools` shape (it passed none, so it still passes). Update `src/index.ts` `buildTools` closure to `(userId) => buildToolsFor({ db, userId })`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/agent/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/index.ts src/agent/core.ts src/index.ts tests/agent/tools/index.test.ts
git commit -m "feat: attach per-user MCP tools to agent turns"
```

---

## Milestone 5 — Web UI

Deliverable: `/login` in Telegram issues a code; entering it in the browser (reachable via firewall) opens a session; user edits models + MCP servers.

### Task 23: Sessions repo + magic code

**Files:**
- Create: `src/db/sessions.ts`
- Test: `tests/db/sessions.test.ts`

**Interfaces:**
- Consumes: `DB`.
- Produces: `startLogin(db, userId): { token: string; code: string }` — generates a random token + 6-digit code, stores unverified with `expires_at = now + 10min`; `verifyCode(db, token, code): boolean` — marks verified if matching + unexpired, clears the code; `getSession(db, token): { user_id, verified } | undefined` (only if unexpired). Random via `crypto.randomBytes` / `crypto.randomInt` (Node builtin).

- [ ] **Step 1: Write the failing test** — `tests/db/sessions.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { startLogin, verifyCode, getSession } from '../../src/db/sessions.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
});

describe('sessions', () => {
  it('verifies a correct code and rejects a wrong one', () => {
    const { token, code } = startLogin(db, uid);
    expect(verifyCode(db, token, 'wrong')).toBe(false);
    expect(verifyCode(db, token, code)).toBe(true);
    expect(getSession(db, token)).toMatchObject({ user_id: uid, verified: 1 });
  });

  it('code cannot be reused after verification', () => {
    const { token, code } = startLogin(db, uid);
    verifyCode(db, token, code);
    expect(verifyCode(db, token, code)).toBe(false); // code cleared
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/db/sessions.ts`**

```typescript
import { randomBytes, randomInt } from 'node:crypto';
import type { DB } from './db.js';

const TTL_MS = 10 * 60 * 1000;

export function startLogin(db: DB, userId: number): { token: string; code: string } {
  const token = randomBytes(24).toString('hex');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare('INSERT INTO sessions (token, user_id, code, verified, expires_at) VALUES (?, ?, ?, 0, ?)').run(
    token,
    userId,
    code,
    Date.now() + TTL_MS,
  );
  return { token, code };
}

export function verifyCode(db: DB, token: string, code: string): boolean {
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as
    | { code: string | null; expires_at: number }
    | undefined;
  if (!row || row.code == null || row.expires_at < Date.now()) return false;
  if (row.code !== code) return false;
  db.prepare('UPDATE sessions SET verified = 1, code = NULL, expires_at = ? WHERE token = ?').run(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
    token,
  );
  return true;
}

export function getSession(db: DB, token: string): { user_id: number; verified: number } | undefined {
  const row = db.prepare('SELECT user_id, verified, expires_at FROM sessions WHERE token = ?').get(token) as
    | { user_id: number; verified: number; expires_at: number }
    | undefined;
  if (!row || row.expires_at < Date.now()) return undefined;
  return { user_id: row.user_id, verified: row.verified };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/sessions.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/sessions.ts tests/db/sessions.test.ts
git commit -m "feat: magic-code sessions repo"
```

---

### Task 24: `/login` bot command + auth handler

**Files:**
- Modify: `src/agent/dispatch.ts` (intercept `/login`), `src/channels/telegram.ts` (deliver DM)
- Create: `src/web/auth.ts`
- Test: `tests/web/auth.test.ts`, extend `tests/agent/dispatch.test.ts`

**Interfaces:**
- Produces (`auth.ts`): `beginBrowserLogin(db, token): { user_id } | undefined` and `checkCode(db, token, code)`; plus `sessionUserId(db, cookieToken): number | undefined` (verified only) used as Fastify middleware helper.
- Modify `handleInbound`: if `m.text.trim() === '/login'` and the user is allowlisted → `startLogin`, send the code + the UI URL to the user, and return (skip the agent). The browser side (Task 25) submits the code.

Flow: user types `/login` → bot DMs "Your code: 123456 — open http://<host>:<port> and enter it." User opens UI, which sets a `token` cookie (issued by a `/login?token=` deep link in the message) and prompts for the code; on match, session becomes verified.

Simpler MVP flow (chosen): the message contains a link `http://<host>:<port>/login?token=<token>`; opening it sets the cookie; the page asks for the 6-digit code; POST verifies. This avoids the user copying a token.

- [ ] **Step 1: Write the failing test** — `tests/web/auth.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { startLogin } from '../../src/db/sessions.js';
import { sessionUserId } from '../../src/web/auth.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
});

describe('sessionUserId', () => {
  it('returns undefined for unverified session', () => {
    const { token } = startLogin(db, uid);
    expect(sessionUserId(db, token)).toBeUndefined();
  });
  it('returns user id for verified session', () => {
    const { token, code } = startLogin(db, uid);
    // verify directly
    const { verifyCode } = require('../../src/db/sessions.js');
    verifyCode(db, token, code);
    expect(sessionUserId(db, token)).toBe(uid);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/web/auth.ts`**

```typescript
import type { DB } from '../db/db.js';
import { getSession } from '../db/sessions.js';

export function sessionUserId(db: DB, cookieToken: string | undefined): number | undefined {
  if (!cookieToken) return undefined;
  const s = getSession(db, cookieToken);
  if (!s || s.verified !== 1) return undefined;
  return s.user_id;
}
```

- [ ] **Step 4: Modify `handleInbound` for `/login`** in `src/agent/dispatch.ts`

Add near the top, after the allowlist check passes but before running a turn:

```typescript
  if (m.text.trim() === '/login') {
    const { token, code } = startLogin(db, user.id);
    const url = `${deps.webBaseUrl}/login?token=${token}`;
    await deps.adapter.send(
      m.channelUserId,
      `Open ${url} and enter this code within 10 minutes:\n\n${code}`,
    );
    return;
  }
```

Add `webBaseUrl: string` to `DispatchDeps` and `import { startLogin } from '../db/sessions.js'`. In `index.ts` set `webBaseUrl` from config (e.g. `http://<server-ip>:<WEB_PORT>` via a new `WEB_BASE_URL` env var — add it to `AppConfig`, `.env.example`, and `loadConfig` with no default (required only if UI used; make it optional with fallback to `http://localhost:${webPort}`)).

- [ ] **Step 5: Add a dispatch test** for `/login` in `tests/agent/dispatch.test.ts`

```typescript
it('handles /login by sending a code + link, no model call', async () => {
  const u = createUser(db, { telegram_id: '30', heartbeat_interval_min: 30 });
  setAllowlisted(db, u.id, true);
  let modelCalled = false;
  const d = { ...deps(), webBaseUrl: 'http://host:8080', generate: async () => { modelCalled = true; return { text: 'x' }; } };
  await handleInbound(d as any, { channelUserId: '30', text: '/login', name: 'Z' });
  expect(modelCalled).toBe(false);
  expect(sent[0][1]).toMatch(/http:\/\/host:8080\/login\?token=/);
  expect(sent[0][1]).toMatch(/\d{6}/);
});
```

(Add `webBaseUrl` to the `deps()` helper's returned object.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/web/auth.test.ts tests/agent/dispatch.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/auth.ts src/agent/dispatch.ts src/config.ts .env.example tests/web/auth.test.ts tests/agent/dispatch.test.ts
git commit -m "feat: /login magic-code flow + session auth helper"
```

---

### Task 25: Fastify server + models screen

**Files:**
- Create: `src/web/server.ts`, `src/web/render.ts`, `src/web/routes/models.ts`
- Test: `tests/web/models-route.test.ts` (via `fastify.inject`)

**Interfaces:**
- Produces (`render.ts`): `layout(title: string, body: string): string` — minimal HTML shell with inline CSS + HTMX `<script>` tag pointing to a bundled/local copy (or omit HTMX and use plain forms for MVP — chosen: plain forms, no external script, to satisfy "no public inbound / self-contained").
- Produces (`server.ts`): `startWeb(deps): Promise<{ close(): Promise<void> }>` where `deps = { db; appCfg; adapter? }`. Registers `@fastify/cookie`, `@fastify/formbody`, the `/login` (GET form + POST verify → set cookie) routes, and mounts `models` + `mcp` routes. An `auth` preHandler resolves `sessionUserId` from the `token` cookie; unauthenticated requests to config pages redirect to `/login`. Binds `0.0.0.0:webPort` (firewall restricts access).
- Produces (`routes/models.ts`): `registerModelsRoutes(app, db)` — `GET /` shows current cheap/strong model + OpenRouter key status + a form; `POST /models` calls `setModels`; `POST /openrouter-key` calls `setOpenrouterKey`.

- [ ] **Step 1: Write the failing test** — `tests/web/models-route.test.ts`

```typescript
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyCode } from '../../src/db/sessions.js';
import { getConfig } from '../../src/db/config.js';
import { buildWebApp } from '../../src/web/server.js';

let db: DB, uid: number, app: any, cookie: string;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(async () => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
  const { token, code } = startLogin(db, uid);
  verifyCode(db, token, code);
  cookie = `token=${token}`;
  app = await buildWebApp({ db, appCfg: {} as any });
});

describe('models route', () => {
  it('redirects unauthenticated users to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('updates the strong model for an authenticated user', async () => {
    const res = await app.inject({
      method: 'POST', url: '/models', headers: { cookie },
      payload: { strong_model: 'anthropic/claude-3.7-sonnet', cheap_model: 'anthropic/claude-3.5-haiku' },
    });
    expect(res.statusCode).toBe(302);
    expect(getConfig(db, uid).strong_model).toBe('anthropic/claude-3.7-sonnet');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web/models-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/web/render.ts`**

```typescript
export function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body{font-family:system-ui;max-width:640px;margin:2rem auto;padding:0 1rem}
  input,button{font-size:1rem;padding:.4rem;margin:.2rem 0}label{display:block;margin-top:.8rem}
  .card{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}
  nav a{margin-right:1rem}</style></head>
  <body><nav><a href="/">Models</a><a href="/mcp">MCP Servers</a></nav>${body}</body></html>`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
```

- [ ] **Step 4: Implement `src/web/routes/models.ts`**

```typescript
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import { getConfig, setModels, setOpenrouterKey, getOpenrouterKey } from '../../db/config.js';
import { layout, esc } from '../render.js';

export function registerModelsRoutes(app: FastifyInstance, db: DB): void {
  app.get('/', async (req, reply) => {
    const userId = (req as any).userId as number;
    const cfg = getConfig(db, userId);
    const hasKey = !!getOpenrouterKey(db, userId);
    reply.type('text/html').send(
      layout(
        'Models',
        `<div class="card"><h2>Models</h2>
        <form method="post" action="/models">
          <label>Cheap model<input name="cheap_model" value="${esc(cfg.cheap_model)}"></label>
          <label>Strong model<input name="strong_model" value="${esc(cfg.strong_model)}"></label>
          <button type="submit">Save models</button>
        </form></div>
        <div class="card"><h2>OpenRouter key</h2>
        <p>${hasKey ? 'Key is set ✅' : 'No key set ❌'}</p>
        <form method="post" action="/openrouter-key">
          <label>API key<input name="key" type="password" placeholder="sk-or-..."></label>
          <button type="submit">Save key</button>
        </form></div>`,
      ),
    );
  });

  app.post<{ Body: { cheap_model: string; strong_model: string } }>('/models', async (req, reply) => {
    const userId = (req as any).userId as number;
    setModels(db, userId, { cheap_model: req.body.cheap_model, strong_model: req.body.strong_model });
    reply.redirect('/');
  });

  app.post<{ Body: { key: string } }>('/openrouter-key', async (req, reply) => {
    const userId = (req as any).userId as number;
    if (req.body.key) setOpenrouterKey(db, userId, req.body.key);
    reply.redirect('/');
  });
}
```

- [ ] **Step 5: Implement `src/web/server.ts`**

```typescript
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { sessionUserId } from './auth.js';
import { verifyCode } from '../db/sessions.js';
import { registerModelsRoutes } from './routes/models.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { layout } from './render.js';

export interface WebDeps {
  db: DB;
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>;
}

const PUBLIC_PATHS = new Set(['/login']);

export async function buildWebApp(deps: WebDeps): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  await app.register(formbody);

  app.addHook('preHandler', async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split('?')[0]!)) return;
    const token = req.cookies.token;
    const userId = sessionUserId(deps.db, token);
    if (!userId) {
      reply.redirect('/login');
      return reply;
    }
    (req as any).userId = userId;
  });

  // Login: GET shows the code form (token comes from the query, stored in cookie), POST verifies.
  app.get<{ Querystring: { token?: string } }>('/login', async (req, reply) => {
    if (req.query.token) reply.setCookie('token', req.query.token, { path: '/', httpOnly: true });
    reply.type('text/html').send(
      layout(
        'Login',
        `<div class="card"><h2>Enter your code</h2>
        <form method="post" action="/login">
          <label>6-digit code<input name="code" inputmode="numeric" pattern="[0-9]{6}"></label>
          <button type="submit">Verify</button>
        </form></div>`,
      ),
    );
  });

  app.post<{ Body: { code: string } }>('/login', async (req, reply) => {
    const token = req.cookies.token;
    if (token && verifyCode(deps.db, token, req.body.code)) {
      reply.redirect('/');
    } else {
      reply.type('text/html').send(layout('Login', '<p>Invalid or expired code. <a href="/login">Try again</a></p>'));
    }
  });

  registerModelsRoutes(app, deps.db);
  registerMcpRoutes(app, deps.db);
  return app;
}

export async function startWeb(deps: WebDeps & { port: number }): Promise<{ close(): Promise<void> }> {
  const app = await buildWebApp(deps);
  await app.listen({ host: '0.0.0.0', port: deps.port });
  return { close: () => app.close() };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/web/models-route.test.ts`
Expected: PASS (2 tests).

(`registerMcpRoutes` is Task 26 — create a temporary empty `src/web/routes/mcp.ts` exporting a no-op `registerMcpRoutes` so this compiles, then flesh it out next task.)

- [ ] **Step 7: Commit**

```bash
git add src/web/server.ts src/web/render.ts src/web/routes/models.ts src/web/routes/mcp.ts tests/web/models-route.test.ts
git commit -m "feat: fastify web app, login page, models config screen"
```

---

### Task 26: MCP config screen

**Files:**
- Modify: `src/web/routes/mcp.ts`
- Test: `tests/web/mcp-route.test.ts`

**Interfaces:**
- Produces: `registerMcpRoutes(app, db)` — `GET /mcp` lists the user's servers + an add form (name, transport select, command/args or url, creds as `KEY=VALUE` lines); `POST /mcp` parses + `addMcpServer`; `POST /mcp/:id/toggle` flips enabled; `POST /mcp/:id/delete` removes. Creds textarea parsed into `Record<string,string>`.

- [ ] **Step 1: Write the failing test** — `tests/web/mcp-route.test.ts`

```typescript
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyCode } from '../../src/db/sessions.js';
import { listMcpServers } from '../../src/db/mcp.js';
import { buildWebApp } from '../../src/web/server.js';

let db: DB, uid: number, app: any, cookie: string;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(async () => {
  db = openDb(':memory:');
  uid = createUser(db, { telegram_id: 't', heartbeat_interval_min: 30 }).id;
  const { token, code } = startLogin(db, uid);
  verifyCode(db, token, code);
  cookie = `token=${token}`;
  app = await buildWebApp({ db, appCfg: {} as any });
});

describe('mcp route', () => {
  it('adds an http mcp server with parsed creds', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mcp', headers: { cookie },
      payload: { name: 'gh', transport: 'http', url: 'https://x/mcp', command: '', args: '', creds: 'Authorization=Bearer z' },
    });
    expect(res.statusCode).toBe(302);
    const list = listMcpServers(db, uid);
    expect(list[0].name).toBe('gh');
    expect(list[0].creds).toEqual({ Authorization: 'Bearer z' });
  });

  it('toggles and deletes a server', async () => {
    await app.inject({ method: 'POST', url: '/mcp', headers: { cookie }, payload: { name: 's', transport: 'stdio', command: 'node', args: 'x.js', url: '', creds: '' } });
    const id = listMcpServers(db, uid)[0].id;
    await app.inject({ method: 'POST', url: `/mcp/${id}/toggle`, headers: { cookie } });
    expect(listMcpServers(db, uid)[0].enabled).toBe(false);
    await app.inject({ method: 'POST', url: `/mcp/${id}/delete`, headers: { cookie } });
    expect(listMcpServers(db, uid)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web/mcp-route.test.ts`
Expected: FAIL — routes are the no-op stub.

- [ ] **Step 3: Implement `src/web/routes/mcp.ts`**

```typescript
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import { addMcpServer, listMcpServers, setMcpEnabled, deleteMcpServer, type McpTransport } from '../../db/mcp.js';
import { layout, esc } from '../render.js';

function parseCreds(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function registerMcpRoutes(app: FastifyInstance, db: DB): void {
  app.get('/mcp', async (req, reply) => {
    const userId = (req as any).userId as number;
    const servers = listMcpServers(db, userId);
    const rows = servers
      .map(
        (s) => `<div class="card"><b>${esc(s.name)}</b> (${s.transport}) ${s.enabled ? '🟢' : '⚪️'}
        <div>${esc(s.url ?? s.command ?? '')}</div>
        <form method="post" action="/mcp/${s.id}/toggle" style="display:inline"><button>${s.enabled ? 'Disable' : 'Enable'}</button></form>
        <form method="post" action="/mcp/${s.id}/delete" style="display:inline"><button>Delete</button></form>
        </div>`,
      )
      .join('');
    reply.type('text/html').send(
      layout(
        'MCP Servers',
        `${rows || '<p>No servers yet.</p>'}
        <div class="card"><h2>Add server</h2>
        <form method="post" action="/mcp">
          <label>Name<input name="name" required></label>
          <label>Transport
            <select name="transport"><option value="stdio">stdio</option><option value="http">http</option><option value="sse">sse</option></select>
          </label>
          <label>Command (stdio)<input name="command" placeholder="node"></label>
          <label>Args (space-separated)<input name="args" placeholder="server.js --flag"></label>
          <label>URL (http/sse)<input name="url" placeholder="https://host/mcp"></label>
          <label>Creds (KEY=VALUE per line)<textarea name="creds" rows="3"></textarea></label>
          <button type="submit">Add</button>
        </form></div>`,
      ),
    );
  });

  app.post<{ Body: { name: string; transport: McpTransport; command?: string; args?: string; url?: string; creds?: string } }>(
    '/mcp',
    async (req, reply) => {
      const userId = (req as any).userId as number;
      const b = req.body;
      addMcpServer(db, userId, {
        name: b.name,
        transport: b.transport,
        command: b.command || undefined,
        args: (b.args ?? '').split(/\s+/).filter(Boolean),
        url: b.url || undefined,
        creds: parseCreds(b.creds ?? ''),
      });
      reply.redirect('/mcp');
    },
  );

  app.post<{ Params: { id: string } }>('/mcp/:id/toggle', async (req, reply) => {
    const userId = (req as any).userId as number;
    const server = listMcpServers(db, userId).find((s) => s.id === Number(req.params.id));
    if (server) setMcpEnabled(db, server.id, !server.enabled);
    reply.redirect('/mcp');
  });

  app.post<{ Params: { id: string } }>('/mcp/:id/delete', async (req, reply) => {
    const userId = (req as any).userId as number;
    const server = listMcpServers(db, userId).find((s) => s.id === Number(req.params.id));
    if (server) deleteMcpServer(db, server.id);
    reply.redirect('/mcp');
  });
}
```

Note: `/mcp/:id/toggle` and `/delete` look up the server within the caller's own `listMcpServers` first — this enforces per-user ownership (a user cannot toggle another user's server by guessing an id).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/web/mcp-route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire web startup in `src/index.ts`**

```typescript
import { startWeb } from './web/server.js';
await startWeb({ db, appCfg, port: appCfg.webPort });
```

- [ ] **Step 6: Full test run + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/web/routes/mcp.ts src/index.ts tests/web/mcp-route.test.ts
git commit -m "feat: MCP config screen (add/toggle/delete, per-user)"
```

---

## Milestone 6 — Provisioning & deploy

Deliverable: one script creates the VPS, installs, deploys, and runs the agent as a service; a firewall opens the UI port only to the owner's IP.

### Task 27: Cloud-init, systemd, deploy + provision scripts

**Files:**
- Create: `provisioning/cloud-init.yaml`, `provisioning/personal-agent.service`, `provisioning/deploy.sh`, `provisioning/provision.sh`, `README.md` (setup section)

No unit tests (shell/infra); validated by a real provisioning run.

- [ ] **Step 1: Create `provisioning/personal-agent.service`**

```ini
[Unit]
Description=Personal Agent
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

- [ ] **Step 2: Create `provisioning/cloud-init.yaml`**

```yaml
#cloud-config
package_update: true
packages:
  - curl
  - git
  - build-essential
users:
  - name: agent
    shell: /bin/bash
    sudo: false
runcmd:
  - curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  - apt-get install -y nodejs
  - mkdir -p /opt/personal-agent/data
  - chown -R agent:agent /opt/personal-agent
```

- [ ] **Step 3: Create `provisioning/deploy.sh`**

```bash
#!/usr/bin/env bash
# Usage: SERVER_IP=x.x.x.x ./provisioning/deploy.sh
# Rsyncs the repo to the VPS, installs deps, (re)starts the service.
set -euo pipefail
: "${SERVER_IP:?set SERVER_IP}"
REMOTE="root@${SERVER_IP}"

rsync -az --delete \
  --exclude node_modules --exclude data --exclude .git \
  ./ "${REMOTE}:/opt/personal-agent/"

ssh "${REMOTE}" bash -s <<'EOF'
set -euo pipefail
cd /opt/personal-agent
npm ci --omit=dev || npm install --omit=dev
npm install tsx           # runtime TS execution
cp provisioning/personal-agent.service /etc/systemd/system/personal-agent.service
chown -R agent:agent /opt/personal-agent
systemctl daemon-reload
systemctl enable personal-agent
systemctl restart personal-agent
systemctl --no-pager status personal-agent | head -n 5
EOF
echo "Deployed to ${SERVER_IP}"
```

- [ ] **Step 4: Create `provisioning/provision.sh`**

```bash
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
fw_id=$(curl -s "${auth[@]}" -X POST "${API}/firewalls" -d @- <<JSON | python3 -c 'import sys,json;print(json.load(sys.stdin)["firewall"]["id"])'
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
user_data=$(cat provisioning/cloud-init.yaml)
curl -s "${auth[@]}" -X POST "${API}/servers" -d @- <<JSON | python3 -c 'import sys,json;d=json.load(sys.stdin);print("server", d["server"]["id"], d["server"]["public_net"]["ipv4"]["ip"])'
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
```

- [ ] **Step 5: Make scripts executable + document**

Run: `chmod +x provisioning/deploy.sh provisioning/provision.sh`

Create `README.md` with a **Setup** section listing the user-supplied inputs (Hetzner token, Telegram bot token, OpenRouter key, owner IP), the `.env` fields, and the exact run order: create SSH key in Hetzner → `provision.sh` → fill `.env` → scp `.env` → `deploy.sh` → message the bot → set your own user `allowlisted=1` (one SQL command, documented) → `/login` for the UI.

- [ ] **Step 6: Manual provisioning validation**

Run `provision.sh` with real credentials against a throwaway Hetzner project; confirm the server boots, `deploy.sh` succeeds, `systemctl status personal-agent` is active, the bot replies, the UI is reachable only from the owner IP.

- [ ] **Step 7: Commit**

```bash
git add provisioning/ README.md
git commit -m "feat: hetzner provisioning + deploy scripts + setup docs"
```

---

## Self-Review Notes (coverage vs spec)

- Cheap infra → Task 27 (cx22 + SQLite). ✅
- Configurable models → Tasks 5, 7, 25. ✅
- Reminders any horizon → Tasks 11–14. ✅
- Follow-ups → Tasks 16 (track), 14 (fire). ✅
- Heartbeat autonomous self-check → Tasks 18, 19. ✅
- MCP support → Tasks 20–22, 26. ✅
- UI (models + MCP) → Tasks 23–26. ✅
- Multi-user isolation + allowlist → Tasks 4, 10; per-user scoping throughout. ✅
- Telegram + typing indicator → Task 9; reactive path Task 10. ✅
- Encryption at rest → Task 2; used in 5, 20. ✅
- Magic-code UI login + firewall gate → Tasks 23, 24, 27. ✅
- WhatsApp later → channel adapter interface (Task 9) leaves the seam. ✅ (not implemented, per decision)
- Shared context later → not built; `user_id` scoping leaves room. ✅ (per decision)

## Post-Implementation

After Task 27, use `superpowers:finishing-a-development-branch` to decide integration. Then do the real-world setup run following `README.md`.
