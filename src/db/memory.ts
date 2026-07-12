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

export function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToVec(b: Buffer): Float32Array {
  // Copy out of better-sqlite3's (possibly pooled) buffer before reinterpreting.
  const u8 = Uint8Array.from(b);
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export function setEmbedding(db: DB, id: number, vec: Float32Array): void {
  db.prepare('UPDATE memory SET embedding = ? WHERE id = ?').run(vecToBlob(vec), id);
}

export function recallVector(
  db: DB, userId: number, queryVec: Float32Array, k = 8, threshold = 0.8,
): MemoryItem[] {
  const rows = db
    .prepare('SELECT * FROM memory WHERE user_id = ? AND embedding IS NOT NULL')
    .all(userId) as (MemoryItem & { embedding: Buffer })[];
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

export function rowsMissingEmbedding(db: DB, limit = 100): { id: number; text: string }[] {
  return db
    .prepare('SELECT id, text FROM memory WHERE embedding IS NULL ORDER BY id LIMIT ?')
    .all(limit) as { id: number; text: string }[];
}
