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
