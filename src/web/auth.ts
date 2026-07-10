import type { DB } from '../db/db.js';
import { getSession } from '../db/sessions.js';

export function sessionUserId(db: DB, cookieToken: string | undefined): number | undefined {
  if (!cookieToken) return undefined;
  const s = getSession(db, cookieToken);
  if (!s || s.verified !== 1) return undefined;
  return s.user_id;
}
