import type { DB } from './db.js';
import { encrypt, decrypt } from '../crypto/encryption.js';

/** Store (or replace) a user's encrypted OAuth refresh token for a provider. */
export function setOAuthToken(db: DB, userId: number, provider: string, plainToken: string): void {
  db.prepare(
    `INSERT INTO oauth_tokens (user_id, provider, token_enc, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET token_enc = excluded.token_enc, created_at = excluded.created_at`,
  ).run(userId, provider, encrypt(plainToken), Date.now());
}

/** Get a user's decrypted refresh token for a provider, or undefined. */
export function getOAuthToken(db: DB, userId: number, provider: string): string | undefined {
  const row = db
    .prepare('SELECT token_enc FROM oauth_tokens WHERE user_id = ? AND provider = ?')
    .get(userId, provider) as { token_enc: string } | undefined;
  return row ? decrypt(row.token_enc) : undefined;
}

export function hasOAuthToken(db: DB, userId: number, provider: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM oauth_tokens WHERE user_id = ? AND provider = ?')
    .get(userId, provider);
  return !!row;
}

export function deleteOAuthToken(db: DB, userId: number, provider: string): void {
  db.prepare('DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ?').run(userId, provider);
}
