import type { DB } from './db.js';

export interface MemoryItem {
  id: number;
  user_id: number;
  mkey: string | null;
  text: string;
  created_at: number;
}

export function remember(db: DB, userId: number, text: string, mkey?: string): number {
  const info = db
    .prepare('INSERT INTO memory (user_id, mkey, text, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, mkey ?? null, text, Date.now());
  return Number(info.lastInsertRowid);
}

export function recall(db: DB, userId: number, query?: string): MemoryItem[] {
  if (query) {
    return db
      .prepare('SELECT * FROM memory WHERE user_id = ? AND text LIKE ? ORDER BY id DESC LIMIT 50')
      .all(userId, `%${query}%`) as MemoryItem[];
  }
  return db
    .prepare('SELECT * FROM memory WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .all(userId) as MemoryItem[];
}

export function forget(db: DB, id: number): void {
  db.prepare('DELETE FROM memory WHERE id = ?').run(id);
}
