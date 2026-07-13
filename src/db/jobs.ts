import type { DB } from './db.js';

export type JobType = 'reminder' | 'followup' | 'heartbeat';

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

export function markDone(db: DB, id: number): void {
  db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(id);
}

export function cancelJob(db: DB, id: number): void {
  db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(id);
}

export function rearmJob(db: DB, id: number, fireAt: number, count: number | null): void {
  db.prepare('UPDATE jobs SET fire_at=?, recurrence_count=? WHERE id=?').run(fireAt, count, id);
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
