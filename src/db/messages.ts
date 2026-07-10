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
