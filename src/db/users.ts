import type { DB } from './db.js';

export interface User {
  id: number;
  name: string | null;
  tz: string;
  quiet_start: number;
  quiet_end: number;
  heartbeat_interval_min: number;
  allowlisted: number;
  is_owner: number;
}

export function createUser(
  db: DB,
  opts: { name?: string; heartbeat_interval_min: number },
): User {
  const info = db
    .prepare('INSERT INTO users (name, heartbeat_interval_min, created_at) VALUES (?, ?, ?)')
    .run(opts.name ?? null, opts.heartbeat_interval_min, nowMs());
  const userId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO config (user_id) VALUES (?)').run(userId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User;
}

export function linkIdentity(db: DB, userId: number, channel: string, externalId: string): number {
  const info = db
    .prepare('INSERT INTO identities (user_id, channel, external_id, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, channel, externalId, nowMs());
  return Number(info.lastInsertRowid);
}

export function createUserWithIdentity(
  db: DB,
  opts: { channel: string; externalId: string; name?: string; heartbeat_interval_min: number },
): User {
  const user = createUser(db, { name: opts.name, heartbeat_interval_min: opts.heartbeat_interval_min });
  linkIdentity(db, user.id, opts.channel, opts.externalId);
  return user;
}

export function getUserByIdentity(db: DB, channel: string, externalId: string): User | undefined {
  return db
    .prepare(
      `SELECT u.* FROM users u
       JOIN identities i ON i.user_id = u.id
       WHERE i.channel = ? AND i.external_id = ?`,
    )
    .get(channel, externalId) as User | undefined;
}

export function getExternalId(db: DB, userId: number, channel: string): string | undefined {
  const row = db
    .prepare('SELECT external_id FROM identities WHERE user_id = ? AND channel = ?')
    .get(userId, channel) as { external_id: string } | undefined;
  return row?.external_id;
}

export function getUserById(db: DB, id: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function isAllowlisted(db: DB, userId: number): boolean {
  const row = db.prepare('SELECT allowlisted FROM users WHERE id = ?').get(userId) as
    | { allowlisted: number }
    | undefined;
  return !!row && row.allowlisted === 1;
}

export function setAllowlisted(db: DB, userId: number, on: boolean): void {
  db.prepare('UPDATE users SET allowlisted = ? WHERE id = ?').run(on ? 1 : 0, userId);
}

export function isOwner(db: DB, userId: number): boolean {
  const row = db.prepare('SELECT is_owner FROM users WHERE id = ?').get(userId) as
    | { is_owner: number }
    | undefined;
  return !!row && row.is_owner === 1;
}

export function setOwner(db: DB, userId: number, on: boolean): void {
  db.prepare('UPDATE users SET is_owner = ? WHERE id = ?').run(on ? 1 : 0, userId);
}

/**
 * Idempotently ensure the owner exists for a Telegram external id: create the
 * user + identity if missing, then allowlist and mark as owner. Safe to call on
 * every boot.
 */
export function ensureOwner(db: DB, telegramExternalId: string): User {
  let user = getUserByIdentity(db, 'telegram', telegramExternalId);
  if (!user) {
    user = createUserWithIdentity(db, {
      channel: 'telegram',
      externalId: telegramExternalId,
      heartbeat_interval_min: 30,
    });
  }
  setAllowlisted(db, user.id, true);
  setOwner(db, user.id, true);
  return getUserById(db, user.id)!;
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
