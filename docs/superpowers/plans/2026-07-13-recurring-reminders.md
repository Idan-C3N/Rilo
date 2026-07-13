# Recurring Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user set repeating reminders (cron-based) with optional until-date / count caps, managed from the bot and the web UI, without changing one-shot reminder behavior.

**Architecture:** Add three nullable recurrence columns to the existing `jobs` table (NULL = one-shot, unchanged). A new pure `scheduler/recurrence.ts` wraps `cron-parser` to compute the next occurrence in the user's timezone. The scheduler `tick` re-arms a recurring job in place (updates `fire_at` + decremented count) after a successful fire instead of marking it done, retiring it when a cap is hit. The `remind` tool gains recurrence args; new bot tools and a web page list/cancel active recurring reminders.

**Tech Stack:** TypeScript (ESM, Node ≥22), better-sqlite3, Fastify, Vitest, `cron-parser` (new dep).

## Global Constraints

- **Node ≥22, ESM** — all relative imports end in `.js` (e.g. `import { addJob } from '../../db/jobs.js'`), matching the codebase.
- **Test runner:** Vitest. Run a single file with `npx vitest run <path>`. Full suite: `npm test`. Typecheck: `npm run typecheck`.
- **DB migrations** are idempotent `ALTER TABLE … ADD COLUMN` guarded by a `PRAGMA table_info` presence check in `src/db/db.ts` `migrate` — never edit existing rows.
- **Backward compatibility:** all three new columns are nullable; NULL recurrence ⇒ existing one-shot behavior must be byte-for-byte unchanged.
- **New dependency:** `cron-parser@^4.9.0` (v4 API: `parseExpression`). Pin to `^4` — the v5 API differs.
- **In-memory DB in tests:** `openDb(':memory:')`; users created via `createUserWithIdentity(db, { channel, externalId, heartbeat_interval_min })`.
- **Commit** after each task's tests pass. Conventional Commits, e.g. `feat(reminders): …`.

---

### Task 1: Recurrence columns + jobs repo

Add the schema columns, the migration, and the jobs-layer functions that read/write them.

**Files:**
- Modify: `src/db/schema.sql` (jobs table, ~line 48)
- Modify: `src/db/db.ts` (`migrate`, ~line 27)
- Modify: `src/db/jobs.ts`
- Test: `tests/db/jobs.test.ts` (extend)

**Interfaces:**
- Consumes: `DB` from `src/db/db.js`.
- Produces:
  - `Job` interface gains `recurrence: string | null`, `recurrence_until: number | null`, `recurrence_count: number | null`.
  - `addJob(db, { userId, type, fireAt, payload, recurrence?, recurrenceUntil?, recurrenceCount? }): number`
  - `rearmJob(db, id: number, fireAt: number, count: number | null): void`
  - `listRecurring(db, userId: number): Job[]`

- [ ] **Step 1: Add columns to `schema.sql`**

In `src/db/schema.sql`, replace the `jobs` table body so it reads:

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,           -- 'reminder' | 'followup' | 'heartbeat'
  fire_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'done' | 'cancelled'
  created_at INTEGER NOT NULL,
  recurrence TEXT,              -- cron expression; NULL = one-shot
  recurrence_until INTEGER,     -- epoch ms; retire once next occurrence would pass this
  recurrence_count INTEGER      -- remaining fires; retire at 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, fire_at);
```

- [ ] **Step 2: Add the migration guard in `db.ts`**

In `src/db/db.ts`, inside `migrate`, after the existing memory-column block, add:

```ts
  const jobCols = new Set(
    (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!jobCols.has('recurrence')) {
    db.exec('ALTER TABLE jobs ADD COLUMN recurrence TEXT');
  }
  if (!jobCols.has('recurrence_until')) {
    db.exec('ALTER TABLE jobs ADD COLUMN recurrence_until INTEGER');
  }
  if (!jobCols.has('recurrence_count')) {
    db.exec('ALTER TABLE jobs ADD COLUMN recurrence_count INTEGER');
  }
```

- [ ] **Step 3: Write the failing tests**

Append to `tests/db/jobs.test.ts` (add the new imports to the existing top import line):

```ts
import { addJob, dueJobs, markDone, cancelJob, pendingJobsByType, rearmJob, listRecurring } from '../../src/db/jobs.js';

describe('recurring jobs', () => {
  it('addJob stores recurrence fields and hydrates them', () => {
    const id = addJob(db, {
      userId: uid, type: 'reminder', fireAt: 100, payload: { text: 'r' },
      recurrence: '0 9 * * 1', recurrenceUntil: 9999, recurrenceCount: 5,
    });
    const job = dueJobs(db, 200).find((j) => j.id === id)!;
    expect(job.recurrence).toBe('0 9 * * 1');
    expect(job.recurrence_until).toBe(9999);
    expect(job.recurrence_count).toBe(5);
  });

  it('one-shot jobs have null recurrence fields', () => {
    addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} });
    const job = dueJobs(db, 100)[0];
    expect(job.recurrence).toBeNull();
    expect(job.recurrence_until).toBeNull();
    expect(job.recurrence_count).toBeNull();
  });

  it('rearmJob updates fire_at + count and keeps the job pending', () => {
    const id = addJob(db, {
      userId: uid, type: 'reminder', fireAt: 10, payload: {}, recurrence: '* * * * *', recurrenceCount: 3,
    });
    rearmJob(db, id, 5000, 2);
    expect(dueJobs(db, 100)).toEqual([]);          // no longer due (fire_at moved to 5000)
    const job = dueJobs(db, 6000).find((j) => j.id === id)!;
    expect(job.fire_at).toBe(5000);
    expect(job.recurrence_count).toBe(2);
  });

  it('rearmJob accepts null count (uncapped)', () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {}, recurrence: '* * * * *' });
    rearmJob(db, id, 5000, null);
    const job = dueJobs(db, 6000).find((j) => j.id === id)!;
    expect(job.recurrence_count).toBeNull();
  });

  it('listRecurring returns only pending recurring jobs for the user', () => {
    const rec = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {}, recurrence: '0 9 * * 1' });
    addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} }); // one-shot, excluded
    const cancelled = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {}, recurrence: '0 9 * * 1' });
    cancelJob(db, cancelled);
    const list = listRecurring(db, uid);
    expect(list.map((j) => j.id)).toEqual([rec]);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/db/jobs.test.ts`
Expected: FAIL — `rearmJob`/`listRecurring` not exported; recurrence fields undefined.

- [ ] **Step 5: Implement the jobs-layer changes**

In `src/db/jobs.ts`:

Extend `Job` and `Row` and `hydrate`:

```ts
export interface Job {
  id: number;
  user_id: number;
  type: JobType;
  fire_at: number;
  payload: Record<string, unknown>;
  status: 'pending' | 'done' | 'cancelled';
  recurrence: string | null;
  recurrence_until: number | null;
  recurrence_count: number | null;
}

interface Row {
  id: number;
  user_id: number;
  type: JobType;
  fire_at: number;
  payload_json: string;
  status: Job['status'];
  recurrence: string | null;
  recurrence_until: number | null;
  recurrence_count: number | null;
}

function hydrate(r: Row): Job {
  return {
    id: r.id, user_id: r.user_id, type: r.type, fire_at: r.fire_at,
    payload: JSON.parse(r.payload_json), status: r.status,
    recurrence: r.recurrence, recurrence_until: r.recurrence_until, recurrence_count: r.recurrence_count,
  };
}
```

Replace `addJob`:

```ts
export function addJob(
  db: DB,
  o: {
    userId: number; type: JobType; fireAt: number; payload: Record<string, unknown>;
    recurrence?: string | null; recurrenceUntil?: number | null; recurrenceCount?: number | null;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO jobs (user_id, type, fire_at, payload_json, created_at, recurrence, recurrence_until, recurrence_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.userId, o.type, o.fireAt, JSON.stringify(o.payload), Date.now(),
      o.recurrence ?? null, o.recurrenceUntil ?? null, o.recurrenceCount ?? null,
    );
  return Number(info.lastInsertRowid);
}
```

Add after `cancelJob`:

```ts
export function rearmJob(db: DB, id: number, fireAt: number, count: number | null): void {
  db.prepare('UPDATE jobs SET fire_at=?, recurrence_count=? WHERE id=?').run(fireAt, count, id);
}

export function listRecurring(db: DB, userId: number): Job[] {
  return (db
    .prepare("SELECT * FROM jobs WHERE user_id=? AND status='pending' AND recurrence IS NOT NULL ORDER BY fire_at ASC")
    .all(userId) as Row[]).map(hydrate);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/db/jobs.test.ts && npm run typecheck`
Expected: PASS (all jobs tests, including the pre-existing ones).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/db.ts src/db/jobs.ts tests/db/jobs.test.ts
git commit -m "feat(reminders): add recurrence columns + jobs repo helpers"
```

---

### Task 2: Next-fire module (`scheduler/recurrence.ts`)

Wrap `cron-parser` in a pure, isolated function that computes the next occurrence in a timezone, plus a human-readable describer for the management surface.

**Files:**
- Create: `src/scheduler/recurrence.ts`
- Test: `tests/scheduler/recurrence.test.ts`
- Modify: `package.json` (add `cron-parser`)

**Interfaces:**
- Produces:
  - `nextFireAt(cron: string, tz: string, after: number): number | null` — epoch ms of the next occurrence strictly after `after` in tz `tz`, or `null` if the expression is invalid or yields nothing.
  - `describeCron(cron: string): string` — a short human-readable label, falling back to the raw expression.

- [ ] **Step 1: Install the dependency**

Run: `npm install cron-parser@^4.9.0`
Expected: `package.json` dependencies gain `"cron-parser": "^4.9.0"`.

- [ ] **Step 2: Write the failing tests**

Create `tests/scheduler/recurrence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { nextFireAt, describeCron } from '../../src/scheduler/recurrence.js';

describe('nextFireAt', () => {
  it('computes the next daily occurrence at a wall-clock time in a timezone', () => {
    // 2026-01-01T00:00:00Z. Next "09:00 every day" in UTC is 2026-01-01T09:00Z.
    const after = Date.UTC(2026, 0, 1, 0, 0, 0);
    const next = nextFireAt('0 9 * * *', 'UTC', after)!;
    expect(next).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
  });

  it('resolves wall-clock time in a non-UTC timezone', () => {
    // 09:00 in Asia/Jerusalem. On 2026-01-01 the offset is +02:00, so 07:00Z.
    const after = Date.UTC(2026, 0, 1, 0, 0, 0);
    const next = nextFireAt('0 9 * * *', 'Asia/Jerusalem', after)!;
    expect(next).toBe(Date.UTC(2026, 0, 1, 7, 0, 0));
  });

  it('returns a time strictly after `after`', () => {
    const at9 = Date.UTC(2026, 0, 1, 9, 0, 0);
    const next = nextFireAt('0 9 * * *', 'UTC', at9)!;
    expect(next).toBe(Date.UTC(2026, 0, 2, 9, 0, 0)); // next day, not the same instant
  });

  it('returns null for an invalid cron expression', () => {
    expect(nextFireAt('not a cron', 'UTC', 0)).toBeNull();
  });
});

describe('describeCron', () => {
  it('falls back to the raw expression', () => {
    expect(typeof describeCron('0 9 * * 1')).toBe('string');
    expect(describeCron('0 9 * * 1').length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/scheduler/recurrence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the module**

Create `src/scheduler/recurrence.ts`:

```ts
import parser from 'cron-parser';

// Next occurrence of `cron` strictly after `after` (epoch ms), interpreted in
// timezone `tz`. Returns null if the expression is invalid or yields nothing.
export function nextFireAt(cron: string, tz: string, after: number): number | null {
  try {
    const interval = parser.parseExpression(cron, { currentDate: new Date(after), tz });
    return interval.next().toDate().getTime();
  } catch {
    return null;
  }
}

// Short human-readable label for a cron expression. cron-parser has no built-in
// English formatter, so we fall back to the raw expression — good enough for a
// management list where the user set the schedule themselves.
export function describeCron(cron: string): string {
  return cron;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/scheduler/recurrence.test.ts && npm run typecheck`
Expected: PASS.

> If typecheck complains about the default import, `cron-parser` v4 ships CJS; with `"esModuleInterop"` (on in this repo's tsconfig) `import parser from 'cron-parser'` resolves. If not, use `import * as parser from 'cron-parser'`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/scheduler/recurrence.ts tests/scheduler/recurrence.test.ts
git commit -m "feat(reminders): add cron next-fire module"
```

---

### Task 3: Scheduler re-arm on fire

After a recurring reminder fires successfully, compute its next occurrence and re-arm in place, or retire it when a cap is hit. One-shot and heartbeat paths unchanged.

**Files:**
- Modify: `src/scheduler/scheduler.ts` (`tick`)
- Test: `tests/scheduler/scheduler.test.ts` (extend)

**Interfaces:**
- Consumes: `nextFireAt` (Task 2), `rearmJob` + `markDone` + `Job` (Task 1), `getUserById` from `src/db/users.js`.
- Produces: no new exports — behavior change to `tick`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/scheduler/scheduler.test.ts` (no new imports — `addJob`, `dueJobs`, `tick` are already imported at the top of the file):

```ts
describe('scheduler tick — recurrence', () => {
  it('re-arms a recurring reminder in place instead of marking it done', async () => {
    // fires every minute; user tz defaults to UTC
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: { text: 'x' }, recurrence: '* * * * *' });
    const { fired, d } = deps();
    const now = Date.UTC(2026, 0, 1, 9, 0, 30); // 09:00:30
    await tick(d as any, now);
    expect(fired).toEqual([['reminder', id]]);
    // still pending, fire_at advanced to the next minute (09:01:00)
    const job = dueJobs(db, now + 3600_000).find((j) => j.id === id)!;
    expect(job.status ?? 'pending').toBe('pending');
    expect(job.fire_at).toBe(Date.UTC(2026, 0, 1, 9, 1, 0));
  });

  it('retires a recurring reminder when the count reaches 0', async () => {
    const id = addJob(db, {
      userId: uid, type: 'reminder', fireAt: 10, payload: { text: 'x' },
      recurrence: '* * * * *', recurrenceCount: 1,
    });
    const { d } = deps();
    await tick(d as any, Date.UTC(2026, 0, 1, 9, 0, 30));
    expect(dueJobs(db, Date.UTC(2027, 0, 1)).find((j) => j.id === id)).toBeUndefined(); // done
  });

  it('retires a recurring reminder once the next occurrence passes recurrence_until', async () => {
    const until = Date.UTC(2026, 0, 1, 9, 0, 45); // before the next minute boundary
    const id = addJob(db, {
      userId: uid, type: 'reminder', fireAt: 10, payload: { text: 'x' },
      recurrence: '* * * * *', recurrenceUntil: until,
    });
    const { d } = deps();
    await tick(d as any, Date.UTC(2026, 0, 1, 9, 0, 30));
    expect(dueJobs(db, Date.UTC(2027, 0, 1)).find((j) => j.id === id)).toBeUndefined(); // done
  });

  it('a downtime gap produces one fire, not one per missed occurrence', async () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: { text: 'x' }, recurrence: '* * * * *' });
    const { fired, d } = deps();
    // Box was "down"; we tick once, far past many missed minutes.
    await tick(d as any, Date.UTC(2026, 0, 1, 12, 0, 0));
    expect(fired).toEqual([['reminder', id]]); // exactly one delivery
    const job = dueJobs(db, Date.UTC(2027, 0, 1)).find((j) => j.id === id)!;
    expect(job.fire_at).toBe(Date.UTC(2026, 0, 1, 12, 1, 0)); // next occurrence from now
  });

  it('one-shot reminders still fire exactly once (regression)', async () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: { text: 'x' } });
    const { fired, d } = deps();
    await tick(d as any, 100);
    expect(fired).toEqual([['reminder', id]]);
    expect(dueJobs(db, 100)).toEqual([]); // done, not re-armed
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scheduler/scheduler.test.ts`
Expected: FAIL — recurring jobs are marked done (not re-armed); count/until not honored.

- [ ] **Step 3: Implement the re-arm branch**

In `src/scheduler/scheduler.ts`, add imports and rewrite `tick`:

```ts
import { dueJobs, markDone, rearmJob, type Job } from '../db/jobs.js';
import { getUserById } from '../db/users.js';
import { nextFireAt } from './recurrence.js';

export async function tick(deps: SchedulerDeps, now: number): Promise<void> {
  for (const job of dueJobs(deps.db, now)) {
    try {
      if (job.type === 'heartbeat') {
        await deps.fireHeartbeat(deps, job);
        markDone(deps.db, job.id); // heartbeat reschedules itself by inserting a new job
      } else {
        await deps.fireReminder(deps, job);
        reschedule(deps, job, now);
      }
    } catch (err) {
      console.error(`job ${job.id} (${job.type}) failed:`, err);
      // left pending → retried next tick; not re-armed until a successful fire
    }
  }
}

// One-shot → markDone. Recurring → compute the next occurrence from `now`
// (skip-to-next: a downtime gap yields a single future fire), decrement the
// count if capped, and retire when the expression is exhausted, the count hits
// 0, or the next occurrence would pass recurrence_until. Otherwise re-arm.
function reschedule(deps: SchedulerDeps, job: Job, now: number): void {
  if (!job.recurrence) {
    markDone(deps.db, job.id);
    return;
  }
  const tz = getUserById(deps.db, job.user_id)?.tz ?? 'UTC';
  const next = nextFireAt(job.recurrence, tz, now);
  const nextCount = job.recurrence_count == null ? null : job.recurrence_count - 1;
  const capReached =
    next === null ||
    (job.recurrence_until != null && next > job.recurrence_until) ||
    nextCount === 0;
  if (capReached) {
    markDone(deps.db, job.id);
  } else {
    rearmJob(deps.db, job.id, next!, nextCount);
  }
}
```

> Note: the previous `tick` called `markDone` unconditionally after a successful fire. That single call is now replaced by `reschedule(...)` for reminders and an explicit `markDone` for heartbeats. Remove the old trailing `markDone(deps.db, job.id);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/scheduler/scheduler.test.ts && npm run typecheck`
Expected: PASS (including the pre-existing tick tests and heartbeat tests).

- [ ] **Step 5: Run the full scheduler suite (guard heartbeat regressions)**

Run: `npx vitest run tests/scheduler/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/scheduler.ts tests/scheduler/scheduler.test.ts
git commit -m "feat(reminders): re-arm recurring jobs on fire with caps + skip-to-next"
```

---

### Task 4: `remind` tool recurrence args

Let the agent create recurring reminders by passing a cron expression and optional caps; first fire is the first occurrence. One-shot path unchanged.

**Files:**
- Modify: `src/agent/tools/remind.ts`
- Test: `tests/agent/tools/remind.test.ts` (extend)

**Interfaces:**
- Consumes: `addJob` (Task 1), `nextFireAt` (Task 2), `getUserById` from `src/db/users.js`.
- Produces: `makeRemindTool(db, userId)` — unchanged signature; the tool now accepts optional `recurrence`, `recurrence_until`, `recurrence_count`.

- [ ] **Step 1: Read the existing test to match its calling convention**

Read `tests/agent/tools/remind.test.ts` to see how the tool's `execute` is invoked (the AI SDK `tool()` object exposes `.execute(args, opts)`). Mirror that convention in the new tests below (the existing tests already call it correctly).

- [ ] **Step 2: Write the failing tests**

Append to `tests/agent/tools/remind.test.ts` (reuse whatever `db`/`uid` setup the file already has; if it calls `tool.execute(args, {} as any)`, use that form):

```ts
import { listRecurring } from '../../../src/db/jobs.js';
import { nextFireAt } from '../../../src/scheduler/recurrence.js';

describe('remind tool — recurrence', () => {
  it('stores a recurring reminder with the first fire at the first occurrence', async () => {
    const tool = makeRemindTool(db, uid);
    await tool.execute!(
      { text: 'standup', recurrence: '0 9 * * 1' } as any,
      {} as any,
    );
    const list = listRecurring(db, uid);
    expect(list).toHaveLength(1);
    expect(list[0].recurrence).toBe('0 9 * * 1');
    // fire_at is a valid future occurrence, not now+delay
    expect(list[0].fire_at).toBe(nextFireAt('0 9 * * 1', 'UTC', list[0].fire_at - 1));
  });

  it('stores caps (until + count)', async () => {
    const tool = makeRemindTool(db, uid);
    await tool.execute!(
      { text: 'daily', recurrence: '0 9 * * *', recurrence_count: 7 } as any,
      {} as any,
    );
    expect(listRecurring(db, uid)[0].recurrence_count).toBe(7);
  });

  it('rejects an invalid cron expression without storing a job', async () => {
    const tool = makeRemindTool(db, uid);
    const res: any = await tool.execute!({ text: 'x', recurrence: 'nope' } as any, {} as any);
    expect(res.ok).toBe(false);
    expect(listRecurring(db, uid)).toHaveLength(0);
  });

  it('one-shot delay_minutes path is unchanged', async () => {
    const tool = makeRemindTool(db, uid);
    const res: any = await tool.execute!({ text: 'soon', delay_minutes: 5 } as any, {} as any);
    expect(res.ok).toBe(true);
    expect(listRecurring(db, uid)).toHaveLength(0); // not recurring
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/agent/tools/remind.test.ts`
Expected: FAIL — tool has no recurrence args.

- [ ] **Step 4: Implement the tool changes**

Replace `src/agent/tools/remind.ts`:

```ts
import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import { addJob } from '../../db/jobs.js';
import { getUserById } from '../../db/users.js';
import { nextFireAt } from '../../scheduler/recurrence.js';

export function makeRemindTool(db: DB, userId: number) {
  return tool({
    description:
      'Schedule a reminder to send back to the user. For a ONE-OFF reminder, set delay_minutes ' +
      '(convert any natural-language time, e.g. "in 2 weeks", into minutes from now). ' +
      'For a REPEATING reminder, set "recurrence" to a 5-field cron expression in the user\'s ' +
      'timezone (e.g. "0 9 * * 1" = every Monday 09:00, "30 15 * * *" = every day 15:30, ' +
      '"0 */2 * * *" = every 2 hours). Optionally cap a repeating reminder with ' +
      '"recurrence_until" (epoch ms — for "for a week" use now + 7 days) and/or ' +
      '"recurrence_count" (number of times — for "5 times" use 5). Omit both caps to repeat forever.',
    inputSchema: z.object({
      text: z.string().describe('What to remind the user about'),
      delay_minutes: z.number().int().positive().optional().describe('One-off: minutes from now to fire'),
      recurrence: z.string().optional().describe('Repeating: 5-field cron expression in the user timezone'),
      recurrence_until: z.number().int().positive().optional().describe('Repeating cap: epoch ms to stop after'),
      recurrence_count: z.number().int().positive().optional().describe('Repeating cap: number of times to fire'),
    }),
    execute: async ({ text, delay_minutes, recurrence, recurrence_until, recurrence_count }) => {
      if (recurrence) {
        const tz = getUserById(db, userId)?.tz ?? 'UTC';
        const first = nextFireAt(recurrence, tz, Date.now());
        if (first === null) {
          return { ok: false, error: 'Invalid recurrence expression.' };
        }
        addJob(db, {
          userId, type: 'reminder', fireAt: first, payload: { text },
          recurrence, recurrenceUntil: recurrence_until ?? null, recurrenceCount: recurrence_count ?? null,
        });
        return { ok: true, fire_at: first, recurring: true };
      }
      if (!delay_minutes) {
        return { ok: false, error: 'Provide either delay_minutes (one-off) or recurrence (repeating).' };
      }
      const fireAt = Date.now() + delay_minutes * 60000;
      addJob(db, { userId, type: 'reminder', fireAt, payload: { text } });
      return { ok: true, fire_at: fireAt };
    },
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/agent/tools/remind.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/remind.ts tests/agent/tools/remind.test.ts
git commit -m "feat(reminders): add recurrence args to the remind tool"
```

---

### Task 5: Management bot tools (`list_reminders`, `cancel_reminder`)

New tools so the user can see and cancel active recurring reminders by talking to the bot.

**Files:**
- Create: `src/agent/tools/reminders.ts`
- Modify: `src/agent/tools/index.ts` (register both tools)
- Test: `tests/agent/tools/reminders.test.ts`

**Interfaces:**
- Consumes: `listRecurring` + `cancelJob` + `Job` (Task 1), `describeCron` (Task 2).
- Produces:
  - `makeListRemindersTool(db, userId)` — returns `{ reminders: Array<{ id, schedule, next_fire, text, remaining }> }`.
  - `makeCancelReminderTool(db, userId)` — input `{ id }`; cancels only a caller-owned recurring reminder; returns `{ ok, cancelled }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/agent/tools/reminders.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUserWithIdentity } from '../../../src/db/users.js';
import { addJob, listRecurring } from '../../../src/db/jobs.js';
import { makeListRemindersTool, makeCancelReminderTool } from '../../../src/agent/tools/reminders.js';

let db: DB, uid: number, other: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 }).id;
  other = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', heartbeat_interval_min: 30 }).id;
});

it('list_reminders returns the caller active recurring reminders', async () => {
  addJob(db, { userId: uid, type: 'reminder', fireAt: 5000, payload: { text: 'standup' }, recurrence: '0 9 * * 1', recurrenceCount: 3 });
  addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} }); // one-shot excluded
  addJob(db, { userId: other, type: 'reminder', fireAt: 5000, payload: { text: 'x' }, recurrence: '0 9 * * 1' }); // other user excluded
  const res: any = await makeListRemindersTool(db, uid).execute!({} as any, {} as any);
  expect(res.reminders).toHaveLength(1);
  expect(res.reminders[0]).toMatchObject({ schedule: '0 9 * * 1', text: 'standup', remaining: 3 });
});

it('cancel_reminder cancels a caller-owned reminder', async () => {
  const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 5000, payload: {}, recurrence: '0 9 * * 1' });
  const res: any = await makeCancelReminderTool(db, uid).execute!({ id } as any, {} as any);
  expect(res.ok).toBe(true);
  expect(listRecurring(db, uid)).toHaveLength(0);
});

it('cancel_reminder refuses to cancel another user reminder', async () => {
  const id = addJob(db, { userId: other, type: 'reminder', fireAt: 5000, payload: {}, recurrence: '0 9 * * 1' });
  const res: any = await makeCancelReminderTool(db, uid).execute!({ id } as any, {} as any);
  expect(res.ok).toBe(false);
  expect(listRecurring(db, other)).toHaveLength(1); // untouched
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent/tools/reminders.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tools**

Create `src/agent/tools/reminders.ts`:

```ts
import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import { listRecurring, cancelJob } from '../../db/jobs.js';
import { describeCron } from '../../scheduler/recurrence.js';

export function makeListRemindersTool(db: DB, userId: number) {
  return tool({
    description: 'List the user\'s active repeating reminders (id, schedule, next fire time, remaining count).',
    inputSchema: z.object({}),
    execute: async () => ({
      reminders: listRecurring(db, userId).map((j) => ({
        id: j.id,
        schedule: describeCron(j.recurrence!),
        next_fire: j.fire_at,
        text: String(j.payload.text ?? ''),
        remaining: j.recurrence_count,
      })),
    }),
  });
}

export function makeCancelReminderTool(db: DB, userId: number) {
  return tool({
    description: 'Cancel one of the user\'s repeating reminders by its id (from list_reminders).',
    inputSchema: z.object({ id: z.number().int().describe('The reminder id to cancel') }),
    execute: async ({ id }) => {
      // Ownership gate: only cancel an id that belongs to this user's active recurring reminders.
      const owned = listRecurring(db, userId).some((j) => j.id === id);
      if (!owned) return { ok: false, error: 'No such reminder for you.' };
      cancelJob(db, id);
      return { ok: true, cancelled: id };
    },
  });
}
```

- [ ] **Step 4: Register the tools in `index.ts`**

In `src/agent/tools/index.ts`, add the import and register in `builtIn`:

```ts
import { makeListRemindersTool, makeCancelReminderTool } from './reminders.js';
```

```ts
  const builtIn: ToolSet = {
    remind: makeRemindTool(db, userId),
    list_reminders: makeListRemindersTool(db, userId),
    cancel_reminder: makeCancelReminderTool(db, userId),
    remember: makeRememberTool(db, userId, opts.embed),
    recall: makeRecallTool(db, userId, opts.embed),
    track: makeTrackTool(db, userId),
    spaces: makeSpacesTool(db, userId),
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/agent/tools/reminders.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/reminders.ts src/agent/tools/index.ts tests/agent/tools/reminders.test.ts
git commit -m "feat(reminders): add list_reminders + cancel_reminder bot tools"
```

---

### Task 6: Web Reminders page (list + cancel)

A "Reminders" nav page listing the logged-in user's active recurring reminders, each with a Cancel button. Follows the Spaces route pattern (form POST + redirect, session-scoped `uidOf`).

**Files:**
- Create: `src/web/routes/reminders.ts`
- Modify: `src/web/render.ts` (add `'reminders'` nav key + nav entry)
- Modify: `src/web/server.ts` (register the route)
- Test: `tests/web/reminders-route.test.ts`

**Interfaces:**
- Consumes: `listRecurring` + `cancelJob` (Task 1), `describeCron` (Task 2), `layout` + `esc` from `src/web/render.js`.
- Produces: `registerRemindersRoutes(app: FastifyInstance, db: DB): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/web/reminders-route.test.ts` (mirror `tests/web/spaces-route.test.ts`'s harness):

```ts
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyByToken } from '../../src/db/sessions.js';
import { buildWebApp } from '../../src/web/server.js';
import { addJob, listRecurring } from '../../src/db/jobs.js';

let db: DB, app: any;
function sessionFor(userId: number): string {
  const { token } = startLogin(db, userId);
  return `token=${verifyByToken(db, token)}`;
}
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildWebApp({
    db, appCfg: {} as any,
    registrationLink: (code: string) => `https://t.me/rilo_bot?start=${code}`,
    notify: async () => {},
  });
});

describe('Reminders web page', () => {
  it('GET /reminders lists the caller active recurring reminders', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    addJob(db, { userId: a.id, type: 'reminder', fireAt: 5000, payload: { text: 'standup' }, recurrence: '0 9 * * 1' });
    const res = await app.inject({ method: 'GET', url: '/reminders', headers: { cookie: sessionFor(a.id) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('standup');
    expect(res.body).toContain('0 9 * * 1');
  });

  it('POST /reminders/:id/cancel cancels a caller-owned reminder', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    const id = addJob(db, { userId: a.id, type: 'reminder', fireAt: 5000, payload: {}, recurrence: '0 9 * * 1' });
    const res = await app.inject({ method: 'POST', url: `/reminders/${id}/cancel`, headers: { cookie: sessionFor(a.id) } });
    expect(res.statusCode).toBe(302);
    expect(listRecurring(db, a.id)).toHaveLength(0);
  });

  it('POST /reminders/:id/cancel does not cancel another user reminder', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    const b = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    const id = addJob(db, { userId: b.id, type: 'reminder', fireAt: 5000, payload: {}, recurrence: '0 9 * * 1' });
    await app.inject({ method: 'POST', url: `/reminders/${id}/cancel`, headers: { cookie: sessionFor(a.id) } });
    expect(listRecurring(db, b.id)).toHaveLength(1); // untouched
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/web/reminders-route.test.ts`
Expected: FAIL — route not registered (404) / module not found.

- [ ] **Step 3: Add the nav key + entry in `render.ts`**

In `src/web/render.ts`:

```ts
export type NavKey = 'home' | 'models' | 'services' | 'spaces' | 'reminders';
```

Add to the `NAV` array (after the `spaces` entry):

```ts
  { key: 'reminders', href: '/reminders', label: 'Reminders' },
```

- [ ] **Step 4: Implement the route**

Create `src/web/routes/reminders.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import { listRecurring, cancelJob } from '../../db/jobs.js';
import { describeCron } from '../../scheduler/recurrence.js';
import { layout, esc } from '../render.js';

export function registerRemindersRoutes(app: FastifyInstance, db: DB): void {
  const uidOf = (req: unknown) => (req as { userId: number }).userId;

  app.get('/reminders', async (req, reply) => {
    const uid = uidOf(req);
    const reminders = listRecurring(db, uid);
    const rows = reminders.length
      ? reminders
          .map((j) => {
            const text = esc(String(j.payload.text ?? '(reminder)'));
            const cap =
              j.recurrence_count != null ? ` · ${j.recurrence_count} left`
              : j.recurrence_until != null ? ` · until ${new Date(j.recurrence_until).toISOString()}`
              : '';
            return `<li>${text} <span class="muted">— ${esc(describeCron(j.recurrence!))}${esc(cap)}</span>
              <form method="post" action="/reminders/${j.id}/cancel" style="display:inline">
                <button type="submit" class="secondary">Cancel</button></form></li>`;
          })
          .join('')
      : '<li class="muted">No repeating reminders yet.</li>';
    const body = `<section class="card"><h2>Repeating reminders</h2><ul>${rows}</ul></section>`;
    reply.type('text/html').send(layout('Reminders', body, { active: 'reminders' }));
  });

  app.post<{ Params: { id: string } }>('/reminders/:id/cancel', async (req, reply) => {
    const uid = uidOf(req);
    const id = Number(req.params.id);
    // Ownership gate: only cancel an id that belongs to this user's active recurring reminders.
    if (listRecurring(db, uid).some((j) => j.id === id)) cancelJob(db, id);
    reply.redirect('/reminders');
  });
}
```

- [ ] **Step 5: Register the route in `server.ts`**

In `src/web/server.ts`, add the import beside the other route imports:

```ts
import { registerRemindersRoutes } from './routes/reminders.js';
```

And register it beside `registerSpacesRoutes(app, deps.db);`:

```ts
  registerRemindersRoutes(app, deps.db);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/web/reminders-route.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS (no regressions across jobs / scheduler / tools / web).

- [ ] **Step 8: Commit**

```bash
git add src/web/routes/reminders.ts src/web/render.ts src/web/server.ts tests/web/reminders-route.test.ts
git commit -m "feat(reminders): add web Reminders page with list + cancel"
```

---

## Final verification

- [ ] `npm test` — full suite green.
- [ ] `npm run typecheck` — no errors.
- [ ] Manual smoke (optional, via `/run` skill): ask the bot "remind me every minute for 3 times", confirm it fires ~3× then stops; open `/reminders`, confirm the entry appears and Cancel removes it.

## Notes / non-goals (from spec)

- Reminder delivery still does **not** apply quiet hours (unchanged); revisit with #15.
- `track`/followups stay one-shot.
- No in-place editing of a recurring reminder — cancel + re-create.
- #15 shared-space reminders remain in the backlog; this plan is the prerequisite.
