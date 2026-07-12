import { randomBytes } from 'node:crypto';
import type { DB } from './db.js';

const TTL_MS = 10 * 60 * 1000;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

/** Mint a one-time login token (10-min TTL). The link carrying it is the sole factor. */
export function startLogin(db: DB, userId: number): { token: string } {
  const token = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, code, verified, expires_at) VALUES (?, ?, NULL, 0, ?)').run(
    token,
    userId,
    Date.now() + TTL_MS,
  );
  return { token };
}

/**
 * Verify a magic-link token and rotate it. Returns a NEW session token to set as
 * the cookie, or undefined if the token is unknown / already used / expired.
 *
 * Rotating the token value in one UPDATE gives both one-time-use (the old link
 * token no longer resolves) and rotation (the long-lived session secret never
 * appeared in a URL).
 */
export function verifyByToken(db: DB, token: string): string | undefined {
  const row = db.prepare('SELECT verified, expires_at FROM sessions WHERE token = ?').get(token) as
    | { verified: number; expires_at: number }
    | undefined;
  if (!row || row.verified === 1 || row.expires_at < Date.now()) return undefined;
  const newToken = randomBytes(24).toString('hex');
  db.prepare('UPDATE sessions SET token = ?, verified = 1, expires_at = ? WHERE token = ?').run(
    newToken,
    Date.now() + SESSION_MS,
    token,
  );
  return newToken;
}

export function getSession(db: DB, token: string): { user_id: number; verified: number } | undefined {
  const row = db.prepare('SELECT user_id, verified, expires_at FROM sessions WHERE token = ?').get(token) as
    | { user_id: number; verified: number; expires_at: number }
    | undefined;
  if (!row || row.expires_at < Date.now()) return undefined;
  return { user_id: row.user_id, verified: row.verified };
}
