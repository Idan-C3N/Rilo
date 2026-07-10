import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { setOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken } from '../../src/db/oauth.js';

let db: DB, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('oauth_tokens repo', () => {
  it('stores the refresh token encrypted and reads it back', () => {
    setOAuthToken(db, uid, 'google', 'refresh-secret');
    const raw = db.prepare('SELECT token_enc FROM oauth_tokens').get() as any;
    expect(raw.token_enc).not.toContain('refresh-secret');
    expect(getOAuthToken(db, uid, 'google')).toBe('refresh-secret');
    expect(hasOAuthToken(db, uid, 'google')).toBe(true);
  });

  it('upserts (replaces) an existing token', () => {
    setOAuthToken(db, uid, 'google', 'first');
    setOAuthToken(db, uid, 'google', 'second');
    expect(getOAuthToken(db, uid, 'google')).toBe('second');
    expect(db.prepare('SELECT COUNT(*) c FROM oauth_tokens').get()).toEqual({ c: 1 });
  });

  it('returns undefined / false when absent, and deletes', () => {
    expect(getOAuthToken(db, uid, 'google')).toBeUndefined();
    expect(hasOAuthToken(db, uid, 'google')).toBe(false);
    setOAuthToken(db, uid, 'google', 'x');
    deleteOAuthToken(db, uid, 'google');
    expect(hasOAuthToken(db, uid, 'google')).toBe(false);
  });
});
