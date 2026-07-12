import { randomBytes } from 'node:crypto';
import type { DB } from './db.js';
import { setAllowlisted } from './users.js';

export type RegStatus =
  | 'awaiting_start'
  | 'awaiting_contact'
  | 'pending_approval'
  | 'approved'
  | 'denied';

export interface Registration {
  id: number;
  name: string;
  phone: string;
  code: string;
  channel: string;
  channel_user_id: string | null;
  user_id: number | null;
  status: RegStatus;
  created_at: number;
  expires_at: number;
}

// Deep-link code TTL for the /start step.
const CODE_TTL_MS = 30 * 60 * 1000;

/** Digits-only normalization. Handles `+972…`, `05…`, punctuation, spaces. */
export function normalizePhone(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * Match two phone numbers by their last 8 digits after normalization — robust
 * across `+972501234567` vs `0501234567` representations. Empty ⇒ no match.
 */
export function phoneMatches(a: string, b: string): boolean {
  const ta = normalizePhone(a).slice(-8);
  const tb = normalizePhone(b).slice(-8);
  return ta.length === 8 && ta === tb;
}

export function createRegistration(
  db: DB,
  opts: { name: string; phone: string; channel?: string },
): Registration {
  const code = randomBytes(24).toString('base64url');
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO pending_registrations
         (name, phone, code, channel, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'awaiting_start', ?, ?)`,
    )
    .run(opts.name, normalizePhone(opts.phone), code, opts.channel ?? 'telegram', now, now + CODE_TTL_MS);
  return db
    .prepare('SELECT * FROM pending_registrations WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as Registration;
}

export function findByCode(db: DB, code: string): Registration | undefined {
  return db
    .prepare('SELECT * FROM pending_registrations WHERE code = ?')
    .get(code) as Registration | undefined;
}

export function bindRequester(
  db: DB,
  regId: number,
  channelUserId: string,
  userId: number,
): void {
  db.prepare(
    `UPDATE pending_registrations
       SET channel_user_id = ?, user_id = ?, status = 'awaiting_contact'
     WHERE id = ?`,
  ).run(channelUserId, userId, regId);
}

export function findAwaitingContact(
  db: DB,
  channel: string,
  channelUserId: string,
): Registration | undefined {
  return db
    .prepare(
      `SELECT * FROM pending_registrations
       WHERE channel = ? AND channel_user_id = ? AND status = 'awaiting_contact'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(channel, channelUserId) as Registration | undefined;
}

export function markPendingApproval(db: DB, regId: number): void {
  db.prepare(
    "UPDATE pending_registrations SET status = 'pending_approval' WHERE id = ?",
  ).run(regId);
}

export function findPendingByUserId(db: DB, userId: number): Registration | undefined {
  return db
    .prepare(
      `SELECT * FROM pending_registrations
       WHERE user_id = ? AND status = 'pending_approval'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(userId) as Registration | undefined;
}

export function listPending(db: DB): Registration[] {
  return db
    .prepare(
      "SELECT * FROM pending_registrations WHERE status = 'pending_approval' ORDER BY id",
    )
    .all() as Registration[];
}

export function approve(db: DB, regId: number): void {
  db.prepare("UPDATE pending_registrations SET status = 'approved' WHERE id = ?").run(regId);
}

export function deny(db: DB, regId: number): void {
  db.prepare("UPDATE pending_registrations SET status = 'denied' WHERE id = ?").run(regId);
}

/**
 * Approve a user's pending request: allowlist them and mark the registration
 * approved. Guarded — only a user currently in `pending_approval` is flipped.
 * Returns the affected registration, or undefined if there was nothing pending.
 * Single source of truth shared by the Telegram command and the web route.
 */
export function approveUser(db: DB, userId: number): Registration | undefined {
  const reg = findPendingByUserId(db, userId);
  if (!reg) return undefined;
  setAllowlisted(db, userId, true);
  approve(db, reg.id);
  return reg;
}

/** Deny a user's pending request (leaves them un-allowlisted). See approveUser. */
export function denyUser(db: DB, userId: number): Registration | undefined {
  const reg = findPendingByUserId(db, userId);
  if (!reg) return undefined;
  deny(db, reg.id);
  return reg;
}
