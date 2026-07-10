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
