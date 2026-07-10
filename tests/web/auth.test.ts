import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { startLogin, verifyCode } from '../../src/db/sessions.js';
import { sessionUserId } from '../../src/web/auth.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('sessionUserId', () => {
  it('returns undefined for unverified session', () => {
    const { token } = startLogin(db, uid);
    expect(sessionUserId(db, token)).toBeUndefined();
  });
  it('returns user id for verified session', () => {
    const { token, code } = startLogin(db, uid);
    verifyCode(db, token, code);
    expect(sessionUserId(db, token)).toBe(uid);
  });
});
