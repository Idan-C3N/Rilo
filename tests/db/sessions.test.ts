import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { startLogin, verifyByToken, getSession } from '../../src/db/sessions.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('sessions (magic-link)', () => {
  it('startLogin issues a token and no code', () => {
    const res = startLogin(db, uid);
    expect(res.token).toMatch(/^[0-9a-f]{48}$/);
    expect((res as any).code).toBeUndefined();
  });

  it('verifyByToken verifies and rotates to a new token', () => {
    const { token } = startLogin(db, uid);
    const sessionToken = verifyByToken(db, token);
    expect(sessionToken).toBeDefined();
    expect(sessionToken).not.toBe(token); // rotated
    expect(getSession(db, sessionToken!)).toMatchObject({ user_id: uid, verified: 1 });
  });

  it('is one-time-use: the old link token no longer resolves', () => {
    const { token } = startLogin(db, uid);
    verifyByToken(db, token);
    expect(verifyByToken(db, token)).toBeUndefined(); // already used / rotated away
    expect(getSession(db, token)).toBeUndefined();
  });

  it('rejects an unknown token', () => {
    expect(verifyByToken(db, 'nope')).toBeUndefined();
  });

  it('rejects an expired token', () => {
    const { token } = startLogin(db, uid);
    // Force expiry in the past.
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1, token);
    expect(verifyByToken(db, token)).toBeUndefined();
  });
});
