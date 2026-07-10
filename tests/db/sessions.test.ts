import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { startLogin, verifyCode, getSession } from '../../src/db/sessions.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('sessions', () => {
  it('verifies a correct code and rejects a wrong one', () => {
    const { token, code } = startLogin(db, uid);
    expect(verifyCode(db, token, 'wrong')).toBe(false);
    expect(verifyCode(db, token, code)).toBe(true);
    expect(getSession(db, token)).toMatchObject({ user_id: uid, verified: 1 });
  });

  it('code cannot be reused after verification', () => {
    const { token, code } = startLogin(db, uid);
    verifyCode(db, token, code);
    expect(verifyCode(db, token, code)).toBe(false); // code cleared
  });
});
