import { randomBytes, randomInt } from 'node:crypto';
import type { DB } from './db.js';

const TTL_MS = 10 * 60 * 1000;

export function startLogin(db: DB, userId: number): { token: string; code: string } {
  const token = randomBytes(24).toString('hex');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare('INSERT INTO sessions (token, user_id, code, verified, expires_at) VALUES (?, ?, ?, 0, ?)').run(
    token,
    userId,
    code,
    Date.now() + TTL_MS,
  );
  return { token, code };
}

export function verifyCode(db: DB, token: string, code: string): boolean {
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as
    | { code: string | null; expires_at: number }
    | undefined;
  if (!row || row.code == null || row.expires_at < Date.now()) return false;
  if (row.code !== code) return false;
  db.prepare('UPDATE sessions SET verified = 1, code = NULL, expires_at = ? WHERE token = ?').run(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
    token,
  );
  return true;
}

export function getSession(db: DB, token: string): { user_id: number; verified: number } | undefined {
  const row = db.prepare('SELECT user_id, verified, expires_at FROM sessions WHERE token = ?').get(token) as
    | { user_id: number; verified: number; expires_at: number }
    | undefined;
  if (!row || row.expires_at < Date.now()) return undefined;
  return { user_id: row.user_id, verified: row.verified };
}
