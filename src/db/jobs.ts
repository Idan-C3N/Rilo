import type { DB } from './db.js';

export type JobType = 'reminder' | 'followup' | 'heartbeat';

export interface Job {
  id: number;
  user_id: number;
  type: JobType;
  fire_at: number;
  payload: Record<string, unknown>;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  recurrence: string | null;
  recurrence_until: number | null;
  recurrence_count: number | null;
  attempts: number;
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
  attempts: number;
}

function hydrate(r: Row): Job {
  return {
    id: r.id, user_id: r.user_id, type: r.type, fire_at: r.fire_at,
    payload: JSON.parse(r.payload_json), status: r.status,
    recurrence: r.recurrence, recurrence_until: r.recurrence_until, recurrence_count: r.recurrence_count,
    attempts: r.attempts,
  };
}

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

export function dueJobs(db: DB, now: number): Job[] {
  return (db
    .prepare("SELECT * FROM jobs WHERE status='pending' AND fire_at <= ? ORDER BY fire_at ASC, id ASC")
    .all(now) as Row[]).map(hydrate);
}

// Atomically claim up to `limit` due, pending jobs: flip them to 'running' and
// return them in one statement. better-sqlite3 serializes writes in-process, so
// no overlapping tick can claim the same rows — this replaces the read-then-fire
// race (dueJobs → fire → markDone) that let concurrent ticks double-dispatch.
// UPDATE...LIMIT is unavailable (SQLite lacks the compile flag), hence the
// `id IN (SELECT ... LIMIT ?)` subquery.
export function claimDueJobs(db: DB, now: number, limit: number): Job[] {
  return (db
    .prepare(
      `UPDATE jobs SET status='running'
       WHERE id IN (
         SELECT id FROM jobs WHERE status='pending' AND fire_at <= ?
         ORDER BY fire_at ASC, id ASC LIMIT ?
       )
       RETURNING *`,
    )
    // RETURNING yields rows in rowid order, not the subquery's ORDER BY; re-sort
    // so the batch dispatches oldest-due-first.
    .all(now, limit) as Row[])
    .map(hydrate)
    .sort((a, b) => a.fire_at - b.fire_at || a.id - b.id);
}

// Recover jobs stranded in 'running' by a crash/restart mid-tick: flip them back
// to 'pending' so the next tick re-dispatches them. Returns the number reclaimed.
// Run once at scheduler start (single-process deployment → any 'running' row is
// an orphan, never a live claim from another worker).
export function reclaimOrphans(db: DB): number {
  return db.prepare("UPDATE jobs SET status='pending' WHERE status='running'").run().changes;
}

// Record a failed dispatch. Increments attempts; retires to 'failed' once the
// count reaches maxAttempts, otherwise re-arms to 'pending' for another try.
// Returns 'failed' or 'retry' accordingly.
export function failJob(db: DB, id: number, maxAttempts: number): 'retry' | 'failed' {
  const row = db
    .prepare(
      `UPDATE jobs
       SET attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
       WHERE id = ?
       RETURNING status`,
    )
    .get(maxAttempts, id) as { status: string };
  return row.status === 'failed' ? 'failed' : 'retry';
}

export function markDone(db: DB, id: number): void {
  db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(id);
}

export function cancelJob(db: DB, id: number): void {
  db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(id);
}

// Re-arm a recurring job for its next occurrence. The job is 'running' (it was
// just claimed and fired), so reset status to 'pending' and clear attempts — a
// successful fire wipes the retry counter.
export function rearmJob(db: DB, id: number, fireAt: number, count: number | null): void {
  db.prepare(
    "UPDATE jobs SET fire_at=?, recurrence_count=?, status='pending', attempts=0 WHERE id=?",
  ).run(fireAt, count, id);
}

export function listRecurring(db: DB, userId: number): Job[] {
  return (db
    .prepare("SELECT * FROM jobs WHERE user_id=? AND status='pending' AND recurrence IS NOT NULL ORDER BY fire_at ASC")
    .all(userId) as Row[]).map(hydrate);
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
