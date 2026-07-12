# Shared Memory (Household Spaces) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let allowlisted users share named memory spaces so household facts are visible to every member, written with writer-only consent.

**Architecture:** Additive SQLite change — two new tables (`spaces`, `space_members`) plus a nullable `memory.space_id` column. A memory row is *personal* (`space_id NULL`, owned by `user_id`) or *shared* (`space_id` set, authored by `user_id`). Recall merges the caller's personal rows with the rows of every space they belong to via one SQL predicate; the existing cosine loop is untouched. Writes to a space are gated on membership and, in chat, on the author confirming.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), better-sqlite3, Vitest, `ai` SDK tools (zod schemas), Fastify web routes with server-rendered HTML.

## Global Constraints

- **Isolated worktree — REQUIRED.** A parallel agent is working other tasks on `main`. Before any code, create and work inside a dedicated git worktree via the `superpowers:using-git-worktrees` skill (branch e.g. `feat/12-shared-memory`). Do **not** commit to `main` directly. All commits in this plan happen on that branch.
- ESM only: every relative import ends in `.js` (e.g. `import { openDb } from '../../src/db/db.js'`).
- Timestamps use `Date.now()` (ms), matching existing repo code.
- Migrations are idempotent and presence-guarded in `db/db.ts` `migrate()` — never assume a fresh DB.
- `remember`'s existing call sites must not break: `agent/tools/track.ts:16` calls `remember(db, userId, 'tracking: ...', 'tracked-task')`. Keep `mkey` as the 4th positional arg; add `spaceId` as the 5th.
- Follow existing file style: small focused files, functions exported top-level, DB helpers as plain functions taking `db` first (see `db/users.ts`).
- Run the full suite with `npm test` (Vitest). Run a single file with `npx vitest run <path>`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/schema.sql` | + `spaces`, `space_members` tables, `memory.space_id` column, indexes |
| `src/db/db.ts` | guarded `ALTER TABLE memory ADD COLUMN space_id` in `migrate()` |
| `src/db/spaces.ts` | **new** — space + membership CRUD |
| `src/db/memory.ts` | scope-aware `remember`; widened `recall`/`recallVector`; `space_id` on `MemoryItem` |
| `src/agent/tools/memory.ts` | `remember` tool gains `space` arg + consent instruction |
| `src/agent/tools/spaces.ts` | **new** — manage spaces from chat |
| `src/agent/tools/index.ts` | register `spaces` tool |
| `src/web/routes/spaces.ts` | **new** — Spaces management page |
| `src/web/server.ts` | mount the Spaces route |
| `src/web/render.ts` | add "Spaces" nav link |

---

## Task 0: Worktree setup

**Files:** none (workspace only)

- [ ] **Step 1: Create the isolated worktree**

Use the `superpowers:using-git-worktrees` skill to create a worktree off `main` on branch `feat/12-shared-memory`. Confirm `git branch --show-current` reports `feat/12-shared-memory` and `git status` is clean before proceeding. Every task below commits on this branch.

---

## Task 1: Schema + migration for spaces

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/db.ts` (`migrate()`)
- Test: `tests/db/migrate-spaces.test.ts` (create)

**Interfaces:**
- Produces: tables `spaces(id, name, created_by, created_at)`, `space_members(space_id, user_id, joined_at)`, and column `memory.space_id INTEGER NULL`. `migrate(db)` adds `space_id` to a pre-existing `memory` table.

- [ ] **Step 1: Write the failing migration test**

Create `tests/db/migrate-spaces.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, openDb } from '../../src/db/db.js';

describe('spaces migration', () => {
  it('adds space_id to a pre-existing memory table', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER);
      CREATE TABLE memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        mkey TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL, embedding BLOB
      );`);
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('space_id');
  });

  it('fresh DB has spaces tables and memory.space_id', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('space_id');
    // tables exist (querying an absent table throws)
    expect(() => db.prepare('SELECT * FROM spaces').all()).not.toThrow();
    expect(() => db.prepare('SELECT * FROM space_members').all()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/migrate-spaces.test.ts`
Expected: FAIL — `space_id` not in cols / `no such table: spaces`.

- [ ] **Step 3: Add tables + column to `schema.sql`**

Append to `src/db/schema.sql` (after the `memory` table block):

```sql
CREATE TABLE IF NOT EXISTS spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS space_members (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members(user_id);
```

Also add `space_id` to the `memory` `CREATE TABLE` (fresh DBs), directly after the `embedding BLOB` line:

```sql
  embedding BLOB,
  space_id INTEGER REFERENCES spaces(id)
```

And add its index after `idx_memory_user`:

```sql
CREATE INDEX IF NOT EXISTS idx_memory_space ON memory(space_id);
```

- [ ] **Step 4: Add the guarded ALTER to `migrate()`**

In `src/db/db.ts`, inside `migrate()`, after the existing `embedding` block, add:

```typescript
  if (!memCols.has('space_id')) {
    db.exec('ALTER TABLE memory ADD COLUMN space_id INTEGER REFERENCES spaces(id)');
  }
```

(`memCols` is already computed above for the `embedding` check — reuse it.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/db/migrate-spaces.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — existing memory tests still green (the new nullable column and empty tables don't change existing queries yet).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/db.ts tests/db/migrate-spaces.test.ts
git commit -m "feat(memory): schema + migration for shared spaces (#12)"
```

---

## Task 2: Space + membership CRUD (`db/spaces.ts`)

**Files:**
- Create: `src/db/spaces.ts`
- Test: `tests/db/spaces.test.ts` (create)

**Interfaces:**
- Consumes: `spaces`, `space_members` tables (Task 1); `User` from `db/users.ts`.
- Produces:
  - `interface Space { id: number; name: string; created_by: number; created_at: number }`
  - `createSpace(db, opts: { name: string; createdBy: number }): Space` — inserts space, adds creator as first member.
  - `addMember(db, spaceId: number, userId: number): void` (idempotent).
  - `removeMember(db, spaceId: number, userId: number): void`.
  - `isMember(db, spaceId: number, userId: number): boolean`.
  - `listSpacesForUser(db, userId: number): Space[]`.
  - `listMembers(db, spaceId: number): User[]`.
  - `getSpaceByName(db, userId: number, name: string): Space | undefined` — resolves a name among the caller's spaces (case-insensitive).

- [ ] **Step 1: Write the failing test**

Create `tests/db/spaces.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import {
  createSpace, addMember, removeMember, isMember,
  listSpacesForUser, listMembers, getSpaceByName,
} from '../../src/db/spaces.js';

let db: DB, a: number, b: number;
beforeEach(() => {
  db = openDb(':memory:');
  a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 }).id;
  b = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', heartbeat_interval_min: 30 }).id;
});

describe('spaces repo', () => {
  it('createSpace makes the creator a member', () => {
    const s = createSpace(db, { name: 'Home', createdBy: a });
    expect(s.name).toBe('Home');
    expect(isMember(db, s.id, a)).toBe(true);
    expect(isMember(db, s.id, b)).toBe(false);
  });

  it('addMember is idempotent; removeMember drops', () => {
    const s = createSpace(db, { name: 'Home', createdBy: a });
    addMember(db, s.id, b);
    addMember(db, s.id, b); // no throw on duplicate
    expect(isMember(db, s.id, b)).toBe(true);
    removeMember(db, s.id, b);
    expect(isMember(db, s.id, b)).toBe(false);
  });

  it('listSpacesForUser returns only joined spaces', () => {
    const home = createSpace(db, { name: 'Home', createdBy: a });
    createSpace(db, { name: 'Work', createdBy: b });
    expect(listSpacesForUser(db, a).map((s) => s.name)).toEqual(['Home']);
    expect(listMembers(db, home.id).map((u) => u.id)).toEqual([a]);
  });

  it('getSpaceByName resolves within the caller\'s spaces, case-insensitive', () => {
    const s = createSpace(db, { name: 'Home', createdBy: a });
    expect(getSpaceByName(db, a, 'home')?.id).toBe(s.id);
    expect(getSpaceByName(db, b, 'Home')).toBeUndefined(); // b not a member
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/spaces.test.ts`
Expected: FAIL — cannot find module `../../src/db/spaces.js`.

- [ ] **Step 3: Implement `db/spaces.ts`**

Create `src/db/spaces.ts`:

```typescript
import type { DB } from './db.js';
import type { User } from './users.js';

export interface Space {
  id: number;
  name: string;
  created_by: number;
  created_at: number;
}

export function createSpace(db: DB, opts: { name: string; createdBy: number }): Space {
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO spaces (name, created_by, created_at) VALUES (?, ?, ?)')
    .run(opts.name, opts.createdBy, now);
  const id = Number(info.lastInsertRowid);
  addMember(db, id, opts.createdBy);
  return db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as Space;
}

export function addMember(db: DB, spaceId: number, userId: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO space_members (space_id, user_id, joined_at) VALUES (?, ?, ?)',
  ).run(spaceId, userId, Date.now());
}

export function removeMember(db: DB, spaceId: number, userId: number): void {
  db.prepare('DELETE FROM space_members WHERE space_id = ? AND user_id = ?').run(spaceId, userId);
}

export function isMember(db: DB, spaceId: number, userId: number): boolean {
  const row = db
    .prepare('SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?')
    .get(spaceId, userId);
  return !!row;
}

export function listSpacesForUser(db: DB, userId: number): Space[] {
  return db
    .prepare(
      `SELECT s.* FROM spaces s
       JOIN space_members m ON m.space_id = s.id
       WHERE m.user_id = ? ORDER BY s.id`,
    )
    .all(userId) as Space[];
}

export function listMembers(db: DB, spaceId: number): User[] {
  return db
    .prepare(
      `SELECT u.* FROM users u
       JOIN space_members m ON m.user_id = u.id
       WHERE m.space_id = ? ORDER BY u.id`,
    )
    .all(spaceId) as User[];
}

export function getSpaceByName(db: DB, userId: number, name: string): Space | undefined {
  return db
    .prepare(
      `SELECT s.* FROM spaces s
       JOIN space_members m ON m.space_id = s.id
       WHERE m.user_id = ? AND LOWER(s.name) = LOWER(?)
       ORDER BY s.id LIMIT 1`,
    )
    .get(userId, name) as Space | undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/db/spaces.test.ts`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add src/db/spaces.ts tests/db/spaces.test.ts
git commit -m "feat(memory): space + membership CRUD (#12)"
```

---

## Task 3: Scope-aware memory (`db/memory.ts`)

**Files:**
- Modify: `src/db/memory.ts`
- Test: `tests/db/memory-scope.test.ts` (create)

**Interfaces:**
- Consumes: `createSpace`, `addMember` from `db/spaces.js` (Task 2).
- Produces:
  - `MemoryItem` gains `space_id: number | null`.
  - `remember(db, userId, text, mkey?, spaceId?)` — 5th positional `spaceId?: number`. `NULL` (omitted) = personal.
  - `recall(db, userId, query?)` and `recallVector(db, userId, queryVec, k?, threshold?)` return the caller's personal rows **plus** rows of every space the caller belongs to.

- [ ] **Step 1: Write the failing scope test**

Create `tests/db/memory-scope.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { createSpace, addMember } from '../../src/db/spaces.js';
import { remember, recall, recallVector, setEmbedding } from '../../src/db/memory.js';

let db: DB, a: number, b: number, c: number, homeId: number;
beforeEach(() => {
  db = openDb(':memory:');
  a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 }).id;
  b = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', heartbeat_interval_min: 30 }).id;
  c = createUserWithIdentity(db, { channel: 'telegram', externalId: 'c', heartbeat_interval_min: 30 }).id;
  homeId = createSpace(db, { name: 'Home', createdBy: a }).id;
  addMember(db, homeId, b);
});

describe('scope-aware recall', () => {
  it('personal facts never leak to another user', () => {
    remember(db, a, 'a-secret');
    expect(recall(db, b).map((m) => m.text)).toEqual([]);
  });

  it('shared facts are visible to every member, not to non-members', () => {
    remember(db, a, 'kids pickup 15:30', undefined, homeId);
    expect(recall(db, b).map((m) => m.text)).toEqual(['kids pickup 15:30']); // b is a member
    expect(recall(db, c).map((m) => m.text)).toEqual([]);                    // c is not
  });

  it('recall merges personal + shared for the caller', () => {
    remember(db, a, 'a-personal');
    remember(db, a, 'shared-fact', undefined, homeId);
    expect(recall(db, a).map((m) => m.text).sort()).toEqual(['a-personal', 'shared-fact']);
  });

  it('MemoryItem carries space_id', () => {
    remember(db, a, 'shared', undefined, homeId);
    const [row] = recall(db, a);
    expect(row?.space_id).toBe(homeId);
  });

  it('recallVector merges shared rows into the ranked set', () => {
    const s = remember(db, a, 'shared-vec', undefined, homeId);
    setEmbedding(db, s, Float32Array.from([1, 0, 0]));
    const hits = recallVector(db, b, Float32Array.from([1, 0, 0]), 8, 0.8);
    expect(hits.map((m) => m.text)).toEqual(['shared-vec']); // b sees a's shared row
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/memory-scope.test.ts`
Expected: FAIL — `remember` ignores the 5th arg / `recall` returns nothing for `b` / `space_id` undefined.

- [ ] **Step 3: Update `MemoryItem` and `remember`**

In `src/db/memory.ts`, add `space_id` to the interface:

```typescript
export interface MemoryItem {
  id: number;
  user_id: number;
  mkey: string | null;
  text: string;
  created_at: number;
  space_id: number | null;
}
```

Replace `remember`:

```typescript
export function remember(
  db: DB, userId: number, text: string, mkey?: string, spaceId?: number,
): number {
  const info = db
    .prepare('INSERT INTO memory (user_id, mkey, text, created_at, space_id) VALUES (?, ?, ?, ?, ?)')
    .run(userId, mkey ?? null, text, Date.now(), spaceId ?? null);
  return Number(info.lastInsertRowid);
}
```

- [ ] **Step 4: Widen `recall` and `recallVector`**

Define a shared predicate at the top of `src/db/memory.ts` (after imports) so both queries stay DRY:

```typescript
// A row is visible to userId if it is their own personal row (space_id NULL)
// or belongs to a space they are a member of.
const VISIBLE = `(
  (memory.space_id IS NULL AND memory.user_id = @uid)
  OR memory.space_id IN (SELECT space_id FROM space_members WHERE user_id = @uid)
)`;
```

Replace `recall`:

```typescript
export function recall(db: DB, userId: number, query?: string): MemoryItem[] {
  if (query) {
    return db
      .prepare(`SELECT * FROM memory WHERE ${VISIBLE} AND text LIKE @q ORDER BY id DESC LIMIT 50`)
      .all({ uid: userId, q: `%${query}%` }) as MemoryItem[];
  }
  return db
    .prepare(`SELECT * FROM memory WHERE ${VISIBLE} ORDER BY id DESC LIMIT 50`)
    .all({ uid: userId }) as MemoryItem[];
}
```

Replace the query inside `recallVector` (leave the cosine/sort/slice logic unchanged):

```typescript
export function recallVector(
  db: DB, userId: number, queryVec: Float32Array, k = 8, threshold = 0.8,
): MemoryItem[] {
  const rows = db
    .prepare(`SELECT * FROM memory WHERE ${VISIBLE} AND embedding IS NOT NULL`)
    .all({ uid: userId }) as (MemoryItem & { embedding: Buffer })[];
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
```

Note: `better-sqlite3` supports named params (`@uid`) mixed into a statement; do not also pass positional args.

- [ ] **Step 5: Run the scope tests**

Run: `npx vitest run tests/db/memory-scope.test.ts`
Expected: PASS (all five).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — existing `tests/db/memory.test.ts` and `memory-vector.test.ts` still green (a user in no spaces sees exactly their own personal rows, identical to before).

- [ ] **Step 7: Commit**

```bash
git add src/db/memory.ts tests/db/memory-scope.test.ts
git commit -m "feat(memory): scope-aware remember + recall merges shared spaces (#12)"
```

---

## Task 4: `remember` tool gains a space arg + consent instruction

**Files:**
- Modify: `src/agent/tools/memory.ts`
- Test: `tests/agent/tools/memory.test.ts` (extend)

**Interfaces:**
- Consumes: `remember` (Task 3, 5-arg), `getSpaceByName` (Task 2).
- Produces: `makeRememberTool(db, userId, embed?)` — tool input gains optional `space: string`; on a valid, member space it writes shared, otherwise returns an error object `{ ok: false, error }`.

- [ ] **Step 1: Read the existing tool test**

Open `tests/agent/tools/memory.test.ts` to match its setup style (how it constructs the tool and calls `.execute`). Mirror that in the new cases below.

- [ ] **Step 2: Write the failing test**

Add to `tests/agent/tools/memory.test.ts`:

```typescript
import { createSpace } from '../../../src/db/spaces.js';
import { recall } from '../../../src/db/memory.js';

// ...inside the existing describe, reusing its db/userId setup helpers:

it('remember writes to a space the user belongs to', async () => {
  const home = createSpace(db, { name: 'Home', createdBy: uid });
  const t = makeRememberTool(db, uid);
  const res = await t.execute!({ text: 'kids pickup 15:30', space: 'Home' }, {} as any);
  expect(res).toEqual({ ok: true });
  const [row] = recall(db, uid);
  expect(row?.space_id).toBe(home.id);
});

it('remember rejects an unknown / non-member space', async () => {
  const t = makeRememberTool(db, uid);
  const res = await t.execute!({ text: 'x', space: 'Nope' }, {} as any) as { ok: boolean };
  expect(res.ok).toBe(false);
  expect(recall(db, uid)).toEqual([]); // nothing written
});

it('remember without space stays personal', async () => {
  const t = makeRememberTool(db, uid);
  await t.execute!({ text: 'personal fact' }, {} as any);
  const [row] = recall(db, uid);
  expect(row?.space_id).toBeNull();
});
```

(Match the exact `.execute` invocation signature the existing tests use; the second arg may differ — copy theirs.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/agent/tools/memory.test.ts`
Expected: FAIL — `space` not accepted / write not scoped.

- [ ] **Step 4: Update `makeRememberTool`**

In `src/agent/tools/memory.ts`, extend imports and the tool:

```typescript
import { remember, recall } from '../../db/memory.js';
import { getSpaceByName } from '../../db/spaces.js';
```

```typescript
export function makeRememberTool(db: DB, userId: number, embed?: Embedder) {
  return tool({
    description:
      'Store a durable fact for future conversations. By default the fact is PRIVATE to this user. ' +
      'Only set "space" when the user asks to share a fact with a space they belong to, OR after you ' +
      'proposed sharing and the user confirmed. When a statement is clearly relevant to a shared space ' +
      '(e.g. a household), ask "Save to <space>?" before setting "space" — do not share silently.',
    inputSchema: z.object({
      text: z.string().describe('The fact to remember'),
      key: z.string().optional().describe('Optional short label'),
      space: z.string().optional().describe('Name of a space to share this fact with; omit to keep it private'),
    }),
    execute: async ({ text, key, space }) => {
      let spaceId: number | undefined;
      if (space) {
        const s = getSpaceByName(db, userId, space);
        if (!s) return { ok: false, error: `No space named "${space}" that you belong to.` };
        spaceId = s.id;
      }
      const id = remember(db, userId, text, key, spaceId);
      if (embed) await embedAndStore(db, id, text, embed);
      return { ok: true };
    },
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/agent/tools/memory.test.ts`
Expected: PASS (existing + three new).

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/memory.ts tests/agent/tools/memory.test.ts
git commit -m "feat(memory): remember tool shares to a space on confirmed consent (#12)"
```

---

## Task 5: `spaces` chat tool

**Files:**
- Create: `src/agent/tools/spaces.ts`
- Modify: `src/agent/tools/index.ts`
- Test: `tests/agent/tools/spaces.test.ts` (create)

**Interfaces:**
- Consumes: `createSpace`, `addMember`, `listSpacesForUser`, `listMembers`, `getSpaceByName`, `isMember` (Task 2); `listAllowlisted`, `getUserById` (`db/users.ts`).
- Produces: `makeSpacesTool(db, userId)` — one tool with an `action` discriminator: `create` | `add_member` | `list` | `leave`.

- [ ] **Step 1: Write the failing test**

Create `tests/agent/tools/spaces.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted } from '../../../src/db/users.js';
import { isMember, listSpacesForUser, getSpaceByName } from '../../../src/db/spaces.js';
import { makeSpacesTool } from '../../../src/agent/tools/spaces.js';

let db: DB, a: number, b: number;
beforeEach(() => {
  db = openDb(':memory:');
  a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', name: 'Idan', heartbeat_interval_min: 30 }).id;
  b = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', name: 'Dana', heartbeat_interval_min: 30 }).id;
  setAllowlisted(db, a, true);
  setAllowlisted(db, b, true);
});

describe('spaces tool', () => {
  it('creates a space with the caller as member', async () => {
    const t = makeSpacesTool(db, a);
    const res = await t.execute!({ action: 'create', name: 'Home' }, {} as any) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(listSpacesForUser(db, a).map((s) => s.name)).toEqual(['Home']);
  });

  it('adds an allowlisted member by name', async () => {
    const t = makeSpacesTool(db, a);
    await t.execute!({ action: 'create', name: 'Home' }, {} as any);
    const res = await t.execute!({ action: 'add_member', name: 'Home', member: 'Dana' }, {} as any) as { ok: boolean };
    expect(res.ok).toBe(true);
    const home = getSpaceByName(db, a, 'Home')!;
    expect(isMember(db, home.id, b)).toBe(true);
  });

  it('rejects add_member when caller is not a member of the space', async () => {
    const other = makeSpacesTool(db, b);
    await other.execute!({ action: 'create', name: 'Work' }, {} as any); // owned by b
    const t = makeSpacesTool(db, a);
    const res = await t.execute!({ action: 'add_member', name: 'Work', member: 'Dana' }, {} as any) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it('leave removes the caller', async () => {
    const t = makeSpacesTool(db, a);
    await t.execute!({ action: 'create', name: 'Home' }, {} as any);
    const res = await t.execute!({ action: 'leave', name: 'Home' }, {} as any) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(listSpacesForUser(db, a)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tools/spaces.test.ts`
Expected: FAIL — cannot find module `spaces.js`.

- [ ] **Step 3: Implement `agent/tools/spaces.ts`**

Create `src/agent/tools/spaces.ts`:

```typescript
import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import {
  createSpace, addMember, removeMember, isMember,
  listSpacesForUser, listMembers, getSpaceByName,
} from '../../db/spaces.js';
import { listAllowlisted } from '../../db/users.js';

export function makeSpacesTool(db: DB, userId: number) {
  return tool({
    description:
      'Manage shared memory spaces. Actions: create a space, add an allowlisted person by name, ' +
      'list your spaces and their members, or leave a space. Facts shared to a space are visible to all its members.',
    inputSchema: z.object({
      action: z.enum(['create', 'add_member', 'list', 'leave']),
      name: z.string().optional().describe('Space name (required for create/add_member/leave)'),
      member: z.string().optional().describe('Name of the allowlisted person to add (add_member)'),
    }),
    execute: async ({ action, name, member }) => {
      if (action === 'list') {
        const spaces = listSpacesForUser(db, userId).map((s) => ({
          name: s.name,
          members: listMembers(db, s.id).map((u) => u.name ?? `user ${u.id}`),
        }));
        return { ok: true, spaces };
      }
      if (!name) return { ok: false, error: 'A space name is required.' };

      if (action === 'create') {
        createSpace(db, { name, createdBy: userId });
        return { ok: true };
      }

      const space = getSpaceByName(db, userId, name);
      if (!space) return { ok: false, error: `No space named "${name}" that you belong to.` };

      if (action === 'leave') {
        removeMember(db, space.id, userId);
        return { ok: true };
      }

      // add_member
      if (!member) return { ok: false, error: 'Which person should I add?' };
      const target = listAllowlisted(db).find(
        (u) => (u.name ?? '').toLowerCase() === member.toLowerCase(),
      );
      if (!target) return { ok: false, error: `No allowlisted person named "${member}".` };
      if (!isMember(db, space.id, userId)) return { ok: false, error: 'You are not a member of that space.' };
      addMember(db, space.id, target.id);
      return { ok: true };
    },
  });
}
```

- [ ] **Step 4: Register the tool in `index.ts`**

In `src/agent/tools/index.ts`, add the import and register it in `builtIn`:

```typescript
import { makeSpacesTool } from './spaces.js';
```

```typescript
  const builtIn: ToolSet = {
    remind: makeRemindTool(db, userId),
    remember: makeRememberTool(db, userId, opts.embed),
    recall: makeRecallTool(db, userId, opts.embed),
    track: makeTrackTool(db, userId),
    spaces: makeSpacesTool(db, userId),
  };
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/agent/tools/spaces.test.ts`
Expected: PASS (all four).

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/spaces.ts src/agent/tools/index.ts tests/agent/tools/spaces.test.ts
git commit -m "feat(memory): spaces chat tool (create/add/list/leave) (#12)"
```

---

## Task 6: Heartbeat sees shared facts (verification)

**Files:**
- Test: `tests/scheduler/heartbeat-shared.test.ts` (create)

**Interfaces:**
- Consumes: `recall` (Task 3, already widened). `scheduler/heartbeat.ts:32` calls `recall(deps.db, userId)` with no query, so shared facts already flow in — **no production code change**. This task locks that behavior with a test.

- [ ] **Step 1: Write the test asserting shared facts are visible to a member's recall**

Create `tests/scheduler/heartbeat-shared.test.ts`. The heartbeat reads facts via `recall(db, userId).map((m) => m.text)` — assert that a space member's `recall` includes a co-member's shared fact (this is exactly the string the heartbeat feeds into its prompt):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { createSpace, addMember } from '../../src/db/spaces.js';
import { remember, recall } from '../../src/db/memory.js';

let db: DB, a: number, b: number;
beforeEach(() => {
  db = openDb(':memory:');
  a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 }).id;
  b = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', heartbeat_interval_min: 30 }).id;
});

describe('heartbeat facts include shared space', () => {
  it('a member sees a co-member\'s shared fact in the recalled facts string', () => {
    const home = createSpace(db, { name: 'Home', createdBy: a });
    addMember(db, home.id, b);
    remember(db, a, 'anniversary Feb 14', undefined, home.id);
    const facts = recall(db, b).map((m) => m.text).join('\n');
    expect(facts).toContain('anniversary Feb 14');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/scheduler/heartbeat-shared.test.ts`
Expected: PASS (recall was widened in Task 3; no code change needed here).

- [ ] **Step 3: Commit**

```bash
git add tests/scheduler/heartbeat-shared.test.ts
git commit -m "test(memory): heartbeat facts include shared space rows (#12)"
```

---

## Task 7: Spaces web page

**Files:**
- Create: `src/web/routes/spaces.ts`
- Modify: `src/web/server.ts` (mount), `src/web/render.ts` (nav link)
- Test: `tests/web/spaces-route.test.ts` (create — mirror the pending-route test setup)

**Interfaces:**
- Consumes: `listSpacesForUser`, `listMembers`, `createSpace`, `getSpaceByName`, `addMember`, `removeMember`, `isMember` (Task 2); `recall`/`forget` (`db/memory.ts`); `listAllowlisted` (`db/users.ts`); `layout`, `esc` (`web/render.ts`); the global `preHandler` sets `(req as any).userId`.
- Produces: `registerSpacesRoutes(app: FastifyInstance, db: DB): void` mounting `GET /spaces`, `POST /spaces` (create), `POST /spaces/:id/members` (add), `POST /spaces/:id/leave`, `POST /spaces/:id/facts/:fid/delete`.

- [ ] **Step 1: Read the pending-route test + `render.ts` helpers**

Open `tests/web/` (find the existing route test, e.g. the pending/register route test) to copy the app-construction + authenticated-request pattern (cookie/session, how `userId` is set). Open `src/web/render.ts` for `layout`, `esc`, and the `NavKey` type.

- [ ] **Step 2: Write the failing route test**

Create `tests/web/spaces-route.test.ts`, mirroring the existing web route test's harness (build the app, authenticate as a user, then):

```typescript
// Pseudocode shape — fill in using the existing web test's exact harness:
// 1. build app with an in-memory db + one allowlisted, logged-in user `a`.
// 2. POST /spaces  { name: 'Home' }        -> 302, listSpacesForUser(db,a) has 'Home'
// 3. GET  /spaces                          -> 200, body contains 'Home'
// 4. POST /spaces/:id/members { member:'Dana' } -> Dana is a member (create Dana allowlisted first)
// 5. POST /spaces/:id/leave                -> a no longer a member
```

Write these as real assertions using the harness you copied (do not leave pseudocode in the committed test).

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/web/spaces-route.test.ts`
Expected: FAIL — route not mounted / module missing.

- [ ] **Step 4: Implement `web/routes/spaces.ts`**

Create `src/web/routes/spaces.ts` (follow `routes/pending.ts` style — `(req as any).userId`, server-rendered HTML via `layout`/`esc`, POST-redirect-GET):

```typescript
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import {
  listSpacesForUser, listMembers, createSpace, getSpaceByName,
  addMember, removeMember, isMember,
} from '../../db/spaces.js';
import { recall, forget } from '../../db/memory.js';
import { listAllowlisted, getUserById } from '../../db/users.js';
import { layout, esc } from '../render.js';

export function registerSpacesRoutes(app: FastifyInstance, db: DB): void {
  const uidOf = (req: unknown) => (req as { userId: number }).userId;

  app.get('/spaces', async (req, reply) => {
    const uid = uidOf(req);
    const spaces = listSpacesForUser(db, uid);
    const allowlisted = listAllowlisted(db);
    const cards = spaces
      .map((s) => {
        const members = listMembers(db, s.id).map((u) => esc(u.name ?? `user ${u.id}`)).join(', ');
        // shared facts in this space = recall rows whose space_id === s.id
        const facts = recall(db, uid).filter((m) => m.space_id === s.id);
        const factRows = facts.length
          ? facts
              .map((m) => {
                const author = getUserById(db, m.user_id)?.name ?? `user ${m.user_id}`;
                return `<li>${esc(m.text)} <span class="muted">— added by ${esc(author)}</span>
                  <form method="post" action="/spaces/${s.id}/facts/${m.id}/delete" style="display:inline">
                    <button type="submit" class="secondary">Delete</button></form></li>`;
              })
              .join('')
          : '<li class="muted">No shared facts yet.</li>';
        const options = allowlisted
          .map((u) => `<option value="${esc(u.name ?? String(u.id))}">`)
          .join('');
        return `<section class="card"><h3>${esc(s.name)}</h3>
          <p class="muted">Members: ${members}</p>
          <ul>${factRows}</ul>
          <form method="post" action="/spaces/${s.id}/members" style="display:inline">
            <input name="member" list="allowlisted-${s.id}" placeholder="Add person by name" required>
            <datalist id="allowlisted-${s.id}">${options}</datalist>
            <button type="submit">Add member</button></form>
          <form method="post" action="/spaces/${s.id}/leave" style="display:inline">
            <button type="submit" class="secondary">Leave</button></form>
        </section>`;
      })
      .join('');
    const createForm = `<section class="card"><h2>Create a space</h2>
      <form method="post" action="/spaces">
        <input name="name" placeholder="e.g. Home" required>
        <button type="submit">Create</button></form></section>`;
    reply.type('text/html').send(layout('Spaces', `${createForm}${cards}`, { active: 'spaces' }));
  });

  app.post<{ Body: { name?: string } }>('/spaces', async (req, reply) => {
    const name = (req.body?.name ?? '').trim();
    if (name) createSpace(db, { name, createdBy: uidOf(req) });
    reply.redirect('/spaces');
  });

  app.post<{ Params: { id: string }; Body: { member?: string } }>('/spaces/:id/members', async (req, reply) => {
    const uid = uidOf(req);
    const spaceId = Number(req.params.id);
    if (isMember(db, spaceId, uid)) {
      const name = (req.body?.member ?? '').trim().toLowerCase();
      const target = listAllowlisted(db).find((u) => (u.name ?? '').toLowerCase() === name);
      if (target) addMember(db, spaceId, target.id);
    }
    reply.redirect('/spaces');
  });

  app.post<{ Params: { id: string } }>('/spaces/:id/leave', async (req, reply) => {
    removeMember(db, Number(req.params.id), uidOf(req));
    reply.redirect('/spaces');
  });

  app.post<{ Params: { id: string; fid: string } }>('/spaces/:id/facts/:fid/delete', async (req, reply) => {
    const uid = uidOf(req);
    const spaceId = Number(req.params.id);
    // any member may delete a shared fact in a space they belong to
    if (isMember(db, spaceId, uid)) forget(db, Number(req.params.fid));
    reply.redirect('/spaces');
  });
}
```

Note the `getSpaceByName` import is available if the route later resolves by name; the ID-based routes above do not need it — remove the unused import before committing if TypeScript's `noUnusedLocals` flags it (check `tsconfig`).

- [ ] **Step 5: Mount the route + add nav**

In `src/web/server.ts`, import and register alongside the other routes (near line 126):

```typescript
import { registerSpacesRoutes } from './routes/spaces.js';
```

```typescript
  registerSpacesRoutes(app, deps.db);
```

In `src/web/render.ts`, add to the `NAV` array (after Services) and extend the `NavKey` type to include `'spaces'`:

```typescript
  { key: 'services', href: '/mcp', label: 'Services' },
  { key: 'spaces', href: '/spaces', label: 'Spaces' },
```

- [ ] **Step 6: Run the route tests + typecheck**

Run: `npx vitest run tests/web/spaces-route.test.ts`
Expected: PASS.
Run: `npm run build` (or the repo's typecheck script) to confirm no TS errors and no unused-import failures.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — whole suite green.

- [ ] **Step 8: Commit**

```bash
git add src/web/routes/spaces.ts src/web/server.ts src/web/render.ts tests/web/spaces-route.test.ts
git commit -m "feat(web): Spaces page — create, add member, view/delete shared facts (#12)"
```

---

## Final verification

- [ ] Run `npm test` — entire suite passes.
- [ ] Run the app locally (`npm run dev`) and manually walk the flow: create a space, add a member, from chat say "remember for Home: kids pickup 15:30" and confirm it appears on `/spaces` attributed to you; log in as the member and recall it.
- [ ] Confirm privacy: a personal fact by user A does not appear in user B's recall (covered by `tests/db/memory-scope.test.ts`, but eyeball once live).

---

## Deferred (not in this plan — noted for the backlog)

- **Shared reminders** — "ping both members" (touches `jobs`; whose device/quiet-hours). Own spec.
- **Shared heartbeat actor** — nudging the household as a unit. Own spec.
- **Invite codes / accept-to-join / recipient write-approval** — rejected for v1.
