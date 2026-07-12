# Semantic Memory Recall via Local Embeddings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make memory `recall` retrieve by meaning (multilingual/Hebrew) using a bundled local embedding server, with a substring fallback that keeps working when the server is absent.

**Architecture:** A new internal-only Docker container (HuggingFace TEI serving `multilingual-e5-small`) computes 384-dim vectors. Vectors are stored as BLOBs in the existing SQLite `memory` table and compared with brute-force cosine in JS. Layering: `embeddings.ts` = pure transport + prefixing; `db/memory.ts` = sync DB ops + blob/cosine math; `agent/memory-embed.ts` = async glue (embed-on-write, semantic recall with fallback, boot backfill).

**Tech Stack:** Node ≥22 (global `fetch`), TypeScript, `better-sqlite3`, `ai` SDK tools, `vitest`, Docker Compose, HuggingFace Text Embeddings Inference.

## Global Constraints

- Model: `intfloat/multilingual-e5-small`, 384-dim. Embed **passages** as `"passage: <text>"`, **queries** as `"query: <text>"` (e5 requirement).
- Embed server reached at `EMBED_URL` (compose injects `http://embed:80`); endpoint `POST {EMBED_URL}/embed`, body `{"inputs": string[]}`, returns `number[][]`.
- Embeddings are enhancement-only: writes never block on embedding; recall falls back to substring `LIKE` when the server is down or no rows are embedded. Nothing in the embed path may throw into the user flow.
- Vectors stored as `Float32Array` bytes in a nullable `memory.embedding BLOB` column. `NULL` = not embedded yet.
- Default recall params: `k = 8`, cosine `threshold = 0.80`.
- Run a single test file with `npx vitest run <path>`; typecheck with `npm run typecheck`.

---

### Task 1: Schema + migration for the `embedding` column

**Files:**
- Modify: `src/db/schema.sql` (memory table)
- Modify: `src/db/db.ts` (export `migrate`, add guarded ALTER)
- Test: `tests/db/migrate-embedding.test.ts`

**Interfaces:**
- Produces: `export function migrate(db: DB): void` (now exported for testing); `memory` table gains nullable `embedding BLOB`.

- [ ] **Step 1: Write the failing test**

Create `tests/db/migrate-embedding.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, openDb } from '../../src/db/db.js';

describe('embedding column migration', () => {
  it('adds embedding to a pre-existing memory table', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER);
      CREATE TABLE memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        mkey TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL
      );`);
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('embedding');
  });

  it('fresh DB already has embedding', () => {
    const cols = (openDb(':memory:').prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('embedding');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/migrate-embedding.test.ts`
Expected: FAIL — `migrate` is not exported (import error) / column missing.

- [ ] **Step 3: Implement**

In `src/db/schema.sql`, add the column to the `memory` CREATE (after `created_at`):

```sql
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mkey TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  embedding BLOB
);
```

In `src/db/db.ts`, change `function migrate` to `export function migrate`, and add a guarded ALTER after the existing `is_owner` block:

```ts
  const memCols = new Set(
    (db.prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!memCols.has('embedding')) {
    db.exec('ALTER TABLE memory ADD COLUMN embedding BLOB');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/migrate-embedding.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql src/db/db.ts tests/db/migrate-embedding.test.ts
git commit -m "feat(memory): add nullable embedding BLOB column + migration"
```

---

### Task 2: `embeddings.ts` — transport + prefixing

**Files:**
- Create: `src/agent/embeddings.ts`
- Test: `tests/agent/embeddings.test.ts`

**Interfaces:**
- Produces:
  - `export type Embedder = (inputs: string[]) => Promise<number[][] | null>`
  - `export function makeEmbedder(baseUrl: string, fetchImpl?: typeof fetch): Embedder`
  - `export function embedQuery(embed: Embedder, text: string): Promise<Float32Array | null>`
  - `export function embedPassages(embed: Embedder, texts: string[]): Promise<(Float32Array | null)[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/agent/embeddings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeEmbedder, embedQuery, embedPassages, type Embedder } from '../../src/agent/embeddings.js';

describe('makeEmbedder', () => {
  it('POSTs inputs to {baseUrl}/embed and returns the matrix', async () => {
    let seen: any;
    const fake = (async (url: string, init: any) => {
      seen = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => [[1, 2, 3]] } as any;
    }) as unknown as typeof fetch;
    const embed = makeEmbedder('http://embed:80/', fake);
    const out = await embed(['x']);
    expect(seen.url).toBe('http://embed:80/embed'); // trailing slash normalized
    expect(seen.body).toEqual({ inputs: ['x'] });
    expect(out).toEqual([[1, 2, 3]]);
  });

  it('returns null on non-OK', async () => {
    const fake = (async () => ({ ok: false, status: 500, text: async () => 'err' }) as any) as unknown as typeof fetch;
    expect(await makeEmbedder('http://e', fake)(['x'])).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fake = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await makeEmbedder('http://e', fake)(['x'])).toBeNull();
  });
});

describe('prefixing helpers', () => {
  it('embedQuery prefixes "query: " and returns a Float32Array', async () => {
    let seen: string[] = [];
    const embed: Embedder = async (inputs) => { seen = inputs; return [[0.1, 0.2]]; };
    const v = await embedQuery(embed, 'hi');
    expect(seen).toEqual(['query: hi']);
    expect(v).toBeInstanceOf(Float32Array);
    expect(Array.from(v!)).toEqual([Math.fround(0.1), Math.fround(0.2)]);
  });

  it('embedPassages prefixes "passage: " per input', async () => {
    let seen: string[] = [];
    const embed: Embedder = async (inputs) => { seen = inputs; return inputs.map(() => [1]); };
    const vs = await embedPassages(embed, ['a', 'b']);
    expect(seen).toEqual(['passage: a', 'passage: b']);
    expect(vs.every((v) => v instanceof Float32Array)).toBe(true);
  });

  it('embedPassages returns all-null when embedder returns null', async () => {
    const embed: Embedder = async () => null;
    expect(await embedPassages(embed, ['a', 'b'])).toEqual([null, null]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/embeddings.test.ts`
Expected: FAIL — module `src/agent/embeddings.ts` not found.

- [ ] **Step 3: Implement**

Create `src/agent/embeddings.ts`:

```ts
// Transport + e5 prefixing for a HuggingFace Text-Embeddings-Inference server.
// Enhancement-only: every failure path resolves to null and never throws.

export type Embedder = (inputs: string[]) => Promise<number[][] | null>;

/** Build an Embedder that POSTs to a TEI server's /embed endpoint. */
export function makeEmbedder(baseUrl: string, fetchImpl: typeof fetch = fetch): Embedder {
  const base = baseUrl.replace(/\/+$/, '');
  return async (inputs) => {
    try {
      const res = await fetchImpl(`${base}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs }),
      });
      if (!res.ok) return null;
      return (await res.json()) as number[][];
    } catch {
      return null;
    }
  };
}

const toVec = (row: number[] | undefined): Float32Array | null =>
  row ? Float32Array.from(row) : null;

/** Embed one query string (e5 "query: " prefix). */
export async function embedQuery(embed: Embedder, text: string): Promise<Float32Array | null> {
  const out = await embed([`query: ${text}`]);
  return out ? toVec(out[0]) : null;
}

/** Embed passages (e5 "passage: " prefix); result aligns 1:1 with inputs. */
export async function embedPassages(embed: Embedder, texts: string[]): Promise<(Float32Array | null)[]> {
  const out = await embed(texts.map((t) => `passage: ${t}`));
  if (!out) return texts.map(() => null);
  return texts.map((_, i) => toVec(out[i]));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/embeddings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/embeddings.ts tests/agent/embeddings.test.ts
git commit -m "feat(memory): TEI embedder transport + e5 query/passage prefixing"
```

---

### Task 3: `db/memory.ts` — vector storage, cosine recall, backfill query

**Files:**
- Modify: `src/db/memory.ts`
- Test: `tests/db/memory-vector.test.ts`

**Interfaces:**
- Consumes: `MemoryItem`, `remember`, `recall` (existing in `src/db/memory.ts`).
- Produces:
  - `export function vecToBlob(v: Float32Array): Buffer`
  - `export function blobToVec(b: Buffer): Float32Array`
  - `export function cosine(a: Float32Array, b: Float32Array): number`
  - `export function setEmbedding(db: DB, id: number, vec: Float32Array): void`
  - `export function recallVector(db: DB, userId: number, queryVec: Float32Array, k?: number, threshold?: number): MemoryItem[]`
  - `export function rowsMissingEmbedding(db: DB, limit?: number): { id: number; text: string }[]`

- [ ] **Step 1: Write the failing test**

Create `tests/db/memory-vector.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import {
  remember, setEmbedding, recallVector, rowsMissingEmbedding,
  vecToBlob, blobToVec, cosine,
} from '../../src/db/memory.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('vector helpers', () => {
  it('blob round-trips a Float32Array', () => {
    const v = Float32Array.from([0.5, -0.25, 1]);
    expect(Array.from(blobToVec(vecToBlob(v)))).toEqual(Array.from(v));
  });
  it('cosine: identical=1, orthogonal=0', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0);
  });
});

describe('recallVector', () => {
  it('ranks by cosine and applies k + threshold', () => {
    const a = remember(db, uid, 'apple');   setEmbedding(db, a, Float32Array.from([1, 0, 0]));
    const b = remember(db, uid, 'banana');  setEmbedding(db, b, Float32Array.from([0.9, 0.1, 0]));
    const c = remember(db, uid, 'carrot');  setEmbedding(db, c, Float32Array.from([0, 1, 0]));
    const hits = recallVector(db, uid, Float32Array.from([1, 0, 0]), 8, 0.8);
    expect(hits.map((m) => m.text)).toEqual(['apple', 'banana']); // carrot below 0.8
  });
  it('skips rows with no embedding', () => {
    remember(db, uid, 'no-vec');
    expect(recallVector(db, uid, Float32Array.from([1, 0, 0]))).toEqual([]);
  });
});

describe('rowsMissingEmbedding', () => {
  it('returns only rows with NULL embedding', () => {
    const a = remember(db, uid, 'has');   setEmbedding(db, a, Float32Array.from([1, 0]));
    remember(db, uid, 'missing');
    expect(rowsMissingEmbedding(db).map((r) => r.text)).toEqual(['missing']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/memory-vector.test.ts`
Expected: FAIL — new exports not defined.

- [ ] **Step 3: Implement**

Append to `src/db/memory.ts` (keep existing `remember`/`recall`/`forget` unchanged):

```ts
export function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToVec(b: Buffer): Float32Array {
  // Copy out of better-sqlite3's (possibly pooled) buffer before reinterpreting.
  const u8 = Uint8Array.from(b);
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export function setEmbedding(db: DB, id: number, vec: Float32Array): void {
  db.prepare('UPDATE memory SET embedding = ? WHERE id = ?').run(vecToBlob(vec), id);
}

export function recallVector(
  db: DB, userId: number, queryVec: Float32Array, k = 8, threshold = 0.8,
): MemoryItem[] {
  const rows = db
    .prepare('SELECT * FROM memory WHERE user_id = ? AND embedding IS NOT NULL')
    .all(userId) as (MemoryItem & { embedding: Buffer })[];
  return rows
    .map((r) => {
      const v = blobToVec(r.embedding);
      return { row: r, score: v.length === queryVec.length ? cosine(v, queryVec) : -1 };
    })
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.row);
}

export function rowsMissingEmbedding(db: DB, limit = 100): { id: number; text: string }[] {
  return db
    .prepare('SELECT id, text FROM memory WHERE embedding IS NULL ORDER BY id LIMIT ?')
    .all(limit) as { id: number; text: string }[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/memory-vector.test.ts`
Expected: PASS. Also run `npx vitest run tests/db/memory.test.ts` — existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/memory.ts tests/db/memory-vector.test.ts
git commit -m "feat(memory): vector blob storage + cosine recallVector + backfill query"
```

---

### Task 4: `agent/memory-embed.ts` — async glue

**Files:**
- Create: `src/agent/memory-embed.ts`
- Test: `tests/agent/memory-embed.test.ts`

**Interfaces:**
- Consumes: `Embedder`, `embedQuery`, `embedPassages` (Task 2); `remember`, `recall`, `setEmbedding`, `recallVector`, `rowsMissingEmbedding` (Task 3).
- Produces:
  - `export function embedAndStore(db: DB, id: number, text: string, embed: Embedder): Promise<void>`
  - `export function semanticRecall(db: DB, userId: number, query: string | undefined, embed: Embedder, k?: number, threshold?: number): Promise<string[]>`
  - `export function backfillEmbeddings(db: DB, embed: Embedder, limit?: number): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `tests/agent/memory-embed.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { remember, recall, rowsMissingEmbedding } from '../../src/db/memory.js';
import { embedAndStore, semanticRecall, backfillEmbeddings } from '../../src/agent/memory-embed.js';
import type { Embedder } from '../../src/agent/embeddings.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

// Deterministic fake: maps known texts to fixed 3-vectors (ignores e5 prefix).
const vecFor = (s: string): number[] =>
  s.includes('apple') ? [1, 0, 0] : s.includes('banana') ? [0.95, 0.05, 0] : [0, 1, 0];
const fakeEmbed: Embedder = async (inputs) => inputs.map(vecFor);
const downEmbed: Embedder = async () => null;

describe('embedAndStore', () => {
  it('stores a vector; failure leaves row NULL', async () => {
    const a = remember(db, uid, 'apple');
    await embedAndStore(db, a, 'apple', fakeEmbed);
    expect(rowsMissingEmbedding(db)).toEqual([]);
    const b = remember(db, uid, 'banana');
    await embedAndStore(db, b, 'banana', downEmbed);
    expect(rowsMissingEmbedding(db).map((r) => r.text)).toEqual(['banana']);
  });
});

describe('semanticRecall', () => {
  it('ranks by vector similarity when embeddings exist', async () => {
    for (const t of ['apple', 'banana', 'carrot']) await embedAndStore(db, remember(db, uid, t), t, fakeEmbed);
    expect(await semanticRecall(db, uid, 'apple pie', fakeEmbed, 8, 0.8)).toEqual(['apple', 'banana']);
  });
  it('falls back to substring when embedder is down', async () => {
    remember(db, uid, 'likes coffee');
    remember(db, uid, 'allergic to peanuts');
    expect(await semanticRecall(db, uid, 'coffee', downEmbed)).toEqual(['likes coffee']);
  });
  it('no query -> recent list', async () => {
    remember(db, uid, 'one'); remember(db, uid, 'two');
    expect(await semanticRecall(db, uid, undefined, fakeEmbed)).toEqual(['two', 'one']);
  });
});

describe('backfillEmbeddings', () => {
  it('embeds only NULL rows and returns the count', async () => {
    remember(db, uid, 'apple'); remember(db, uid, 'carrot');
    const n = await backfillEmbeddings(db, fakeEmbed);
    expect(n).toBe(2);
    expect(rowsMissingEmbedding(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/memory-embed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/agent/memory-embed.ts`:

```ts
import type { DB } from '../db/db.js';
import type { Embedder } from './embeddings.js';
import { embedQuery, embedPassages } from './embeddings.js';
import { recall, setEmbedding, recallVector, rowsMissingEmbedding } from '../db/memory.js';

/** Best-effort: embed one memory's text and persist the vector. Never throws. */
export async function embedAndStore(db: DB, id: number, text: string, embed: Embedder): Promise<void> {
  const [vec] = await embedPassages(embed, [text]);
  if (vec) setEmbedding(db, id, vec);
}

/**
 * Semantic recall with graceful fallback. Returns memory texts.
 * - no query        -> recent list
 * - server down/no hits -> substring LIKE (today's behavior)
 */
export async function semanticRecall(
  db: DB, userId: number, query: string | undefined, embed: Embedder, k = 8, threshold = 0.8,
): Promise<string[]> {
  if (!query) return recall(db, userId).map((m) => m.text);
  const vec = await embedQuery(embed, query);
  if (vec) {
    const hits = recallVector(db, userId, vec, k, threshold);
    if (hits.length) return hits.map((m) => m.text);
  }
  return recall(db, userId, query).map((m) => m.text);
}

/** Embed rows that have no vector yet (boot backfill). Returns how many filled. */
export async function backfillEmbeddings(db: DB, embed: Embedder, limit = 100): Promise<number> {
  const rows = rowsMissingEmbedding(db, limit);
  let filled = 0;
  for (const r of rows) {
    const [vec] = await embedPassages(embed, [r.text]);
    if (vec) { setEmbedding(db, r.id, vec); filled++; }
  }
  return filled;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/memory-embed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/memory-embed.ts tests/agent/memory-embed.test.ts
git commit -m "feat(memory): embed-on-write, semantic recall w/ fallback, boot backfill"
```

---

### Task 5: Thread the embedder through the memory tools

**Files:**
- Modify: `src/agent/tools/memory.ts`
- Test: `tests/agent/tools/memory.test.ts` (extend)

**Interfaces:**
- Consumes: `embedAndStore`, `semanticRecall` (Task 4); `Embedder` (Task 2).
- Produces (updated signatures, `embed` optional & backward-compatible):
  - `makeRememberTool(db: DB, userId: number, embed?: Embedder)`
  - `makeRecallTool(db: DB, userId: number, embed?: Embedder)`

- [ ] **Step 1: Write the failing test**

Append to `tests/agent/tools/memory.test.ts` (add imports at top:
`import type { Embedder } from '../../../src/agent/embeddings.js';`):

```ts
describe('memory tools with embedder', () => {
  const vecFor = (s: string): number[] => (s.includes('tea') ? [1, 0] : [0, 1]);
  const fakeEmbed: Embedder = async (inputs) => inputs.map(vecFor);

  it('recall tool uses semantic ranking when embed is provided', async () => {
    await (makeRememberTool(db, uid, fakeEmbed) as any).execute({ text: 'drinks tea' });
    await (makeRememberTool(db, uid, fakeEmbed) as any).execute({ text: 'owns a bike' });
    const res = await (makeRecallTool(db, uid, fakeEmbed) as any).execute({ query: 'green tea' });
    expect(res.items).toEqual(['drinks tea']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tools/memory.test.ts`
Expected: FAIL — `makeRememberTool` ignores the 3rd arg / semantic path absent.

- [ ] **Step 3: Implement**

Replace `src/agent/tools/memory.ts` with:

```ts
import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import { remember, recall } from '../../db/memory.js';
import type { Embedder } from '../embeddings.js';
import { embedAndStore, semanticRecall } from '../memory-embed.js';

export function makeRememberTool(db: DB, userId: number, embed?: Embedder) {
  return tool({
    description: 'Store a durable fact about the user for future conversations.',
    inputSchema: z.object({
      text: z.string().describe('The fact to remember'),
      key: z.string().optional().describe('Optional short label'),
    }),
    execute: async ({ text, key }) => {
      const id = remember(db, userId, text, key);
      if (embed) await embedAndStore(db, id, text, embed);
      return { ok: true };
    },
  });
}

export function makeRecallTool(db: DB, userId: number, embed?: Embedder) {
  return tool({
    description: 'Recall stored facts about the user. Optionally filter by a query.',
    inputSchema: z.object({
      query: z.string().optional().describe('What to recall; omit to list recent facts'),
    }),
    execute: async ({ query }) => ({
      items: embed
        ? await semanticRecall(db, userId, query, embed)
        : recall(db, userId, query).map((m) => m.text),
    }),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/tools/memory.test.ts`
Expected: PASS (existing no-embed tests + new semantic test).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/memory.ts tests/agent/tools/memory.test.ts
git commit -m "feat(memory): recall/remember tools use semantic path when embedder present"
```

---

### Task 6: Config + boot wiring

**Files:**
- Modify: `src/config.ts` (add `embedUrl`)
- Modify: `src/agent/tools/index.ts` (accept + wire `embed`)
- Modify: `src/index.ts` (build embedder, thread it, run boot backfill)
- Test: `tests/config.test.ts` (create)

**Interfaces:**
- Consumes: `makeEmbedder` (Task 2), `backfillEmbeddings` (Task 4), `Embedder` (Task 2).
- Produces: `AppConfig.embedUrl?: string`; `buildToolsFor` opts gain `embed?: Embedder`.

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DB_PATH: 'x', ENC_KEY: 'y', TELEGRAM_TOKEN: 'z' } as any;

describe('loadConfig embedUrl', () => {
  it('reads EMBED_URL when set', () => {
    expect(loadConfig({ ...base, EMBED_URL: 'http://embed:80' }).embedUrl).toBe('http://embed:80');
  });
  it('is undefined when unset', () => {
    expect(loadConfig(base).embedUrl).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `embedUrl` missing on `AppConfig`.

- [ ] **Step 3: Implement**

In `src/config.ts`: add `embedUrl?: string;` to the `AppConfig` interface, and in the returned object add:

```ts
    embedUrl: env.EMBED_URL || undefined,
```

In `src/agent/tools/index.ts`: import the type and wire it:

```ts
import type { Embedder } from '../embeddings.js';
```

Add `embed?: Embedder;` to the `buildToolsFor` opts type, and update the built-in wiring:

```ts
    remember: makeRememberTool(db, userId, opts.embed),
    recall: makeRecallTool(db, userId, opts.embed),
```

In `src/index.ts`: add imports:

```ts
import { makeEmbedder } from './agent/embeddings.js';
import { backfillEmbeddings } from './agent/memory-embed.js';
```

Build the embedder and thread it into `buildToolsFor` (replace the existing `buildTools` definition):

```ts
const embed = appCfg.embedUrl ? makeEmbedder(appCfg.embedUrl) : undefined;
const buildTools = (userId: number) => buildToolsFor({ db, userId, search, google, embed });
```

After `seedHeartbeats(db, appCfg);`, kick off a best-effort boot backfill (non-blocking):

```ts
if (embed) {
  backfillEmbeddings(db, embed)
    .then((n) => n && console.log(`memory: backfilled ${n} embeddings`))
    .catch((err) => console.warn('memory: embedding backfill failed:', err));
}
```

- [ ] **Step 4: Run test + typecheck + full suite**

Run: `npx vitest run tests/config.test.ts` → PASS
Run: `npm run typecheck` → no errors
Run: `npm test` → all PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/agent/tools/index.ts src/index.ts tests/config.test.ts
git commit -m "feat(memory): wire EMBED_URL -> embedder into tools + boot backfill"
```

---

### Task 7: Docker `embed` service + config docs

**Files:**
- Modify: `compose.yml` (add `embed` service + `EMBED_URL` on `app`)
- Modify: `.env.example` (document `EMBED_URL` for native runs)
- Modify: `deploy/README.md` (note the bundled embed container)

**Interfaces:** none (infra). Verified by `docker compose config` + existing tests/typecheck.

- [ ] **Step 1: Edit `compose.yml`**

Add `EMBED_URL` to the `app` service `environment:` block (next to `SEARXNG_URL`):

```yaml
      EMBED_URL: http://embed:80   # bundled embedding server (internal only)
```

Add the `embed` service (sibling of `searxng`) and a named volume:

```yaml
  # Bundled multilingual embedding server for semantic memory recall.
  # Internal-only (no host publish); the app reaches it at http://embed:80.
  embed:
    image: ghcr.io/huggingface/text-embeddings-inference:cpu-latest
    command: ["--model-id", "intfloat/multilingual-e5-small"]
    volumes:
      - embed_models:/data          # cache the model download across restarts
    restart: unless-stopped
```

Add to the top-level `volumes:` (create the key if absent):

```yaml
volumes:
  embed_models:
```

- [ ] **Step 2: Edit `.env.example`**

Under a new comment near the search block:

```
# --- Semantic memory (embeddings) ---
# Docker: the bundled `embed` container is wired automatically — leave this alone.
# Native (npm) runs have no embed server, so recall falls back to substring match.
# Point at your own TEI server to enable semantic recall natively:
# EMBED_URL=http://localhost:8081
```

- [ ] **Step 3: Edit `deploy/README.md`**

In the intro paragraph that lists the bundled SearXNG, add embed alongside it, e.g. append a sentence:

```
A bundled **embedding** container (HuggingFace TEI, `multilingual-e5-small`)
powers semantic memory recall; like SearXNG it is internal-only and needs no
host port or firewall rule.
```

- [ ] **Step 4: Validate compose + full suite**

Run: `docker compose -f compose.yml config >/dev/null && echo OK` → `OK`
Run: `npm test` → all PASS
Run: `npm run typecheck` → clean

- [ ] **Step 5: Commit**

```bash
git add compose.yml .env.example deploy/README.md
git commit -m "feat(deploy): bundle multilingual-e5 embedding container for semantic memory"
```

---

## Deployment (after merge to main)

```bash
cd /opt/personal-agent && git pull
docker compose -f compose.yml -f compose.caddy.yml up -d --build
```

First boot pulls the TEI image + downloads `multilingual-e5-small` into the
`embed_models` volume (one-time), then the boot backfill embeds the existing
memories. Verify:

```bash
docker compose -f compose.yml -f compose.caddy.yml logs --tail=20 embed   # model loaded
docker compose -f compose.yml -f compose.caddy.yml logs app | grep backfill
```

## Self-Review Notes

- **Spec coverage:** container (Task 7), schema/migration (Task 1), `embeddings.ts` + e5 prefixes (Task 2), blob/cosine/recallVector/backfill query (Task 3), embed-on-write + semanticRecall + backfill (Task 4), tool wiring (Task 5), config/boot/graceful-absence (Task 6). All spec sections mapped.
- **Fallback paths:** server-down and no-vectors both covered by tests in Task 4; write-never-blocks covered in Task 4 (`downEmbed`).
- **Type consistency:** `Embedder` returns `number[][] | null`; `embedQuery`→`Float32Array|null`; `embedPassages`→`(Float32Array|null)[]`; `setEmbedding` takes `Float32Array`; `semanticRecall`→`string[]` (matches `recall(...).map(text)` tool output). Consistent across tasks.
