import { randomInt } from 'node:crypto';
import type { DB } from './db.js';
import { addMember } from './spaces.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no O/0/I/1/L
const CODE_LEN = 6;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SpaceInvite {
  id: number;
  space_id: number;
  code: string;
  created_by: number;
  created_at: number;
  expires_at: number;
  redeemed_by: number | null;
  redeemed_at: number | null;
}

function genCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return s;
}

export function createInvite(
  db: DB,
  o: { spaceId: number; createdBy: number; ttlMs?: number },
): { code: string } {
  const now = Date.now();
  const expiresAt = now + (o.ttlMs ?? DEFAULT_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genCode();
    try {
      db.prepare(
        'INSERT INTO space_invites (space_id, code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      ).run(o.spaceId, code, o.createdBy, now, expiresAt);
      return { code };
    } catch (e) {
      if (String(e).includes('UNIQUE')) continue; // astronomically rare — retry
      throw e;
    }
  }
  throw new Error('could not generate a unique invite code');
}

export function getValidInvite(db: DB, code: string): SpaceInvite | undefined {
  // Codes are uppercase; normalize so a user typing lowercase in chat still matches.
  const row = db.prepare('SELECT * FROM space_invites WHERE code = ?').get(code.toUpperCase()) as
    | SpaceInvite
    | undefined;
  if (!row || row.redeemed_at !== null || row.expires_at <= Date.now()) return undefined;
  return row;
}

export function redeemInvite(
  db: DB,
  code: string,
  userId: number,
): { ok: boolean; spaceId?: number; error?: string } {
  const tx = db.transaction(() => {
    const inv = getValidInvite(db, code);
    if (!inv) return { ok: false, error: 'Invalid, expired, or already-used code.' };
    addMember(db, inv.space_id, userId);
    db.prepare('UPDATE space_invites SET redeemed_by = ?, redeemed_at = ? WHERE id = ?').run(
      userId,
      Date.now(),
      inv.id,
    );
    return { ok: true, spaceId: inv.space_id };
  });
  return tx() as { ok: boolean; spaceId?: number; error?: string };
}

export function listActiveInvites(db: DB, spaceId: number): SpaceInvite[] {
  return db
    .prepare(
      'SELECT * FROM space_invites WHERE space_id = ? AND redeemed_at IS NULL AND expires_at > ? ORDER BY id',
    )
    .all(spaceId, Date.now()) as SpaceInvite[];
}
