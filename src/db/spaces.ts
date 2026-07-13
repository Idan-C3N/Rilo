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
