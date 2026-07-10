import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { getConfig, setModels, setOpenrouterKey, getOpenrouterKey } from '../../src/db/config.js';

let db: DB, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('config repo', () => {
  it('updates models', () => {
    setModels(db, uid, { strong_model: 'anthropic/claude-3.7-sonnet' });
    expect(getConfig(db, uid).strong_model).toBe('anthropic/claude-3.7-sonnet');
  });

  it('stores openrouter key encrypted and reads it back', () => {
    setOpenrouterKey(db, uid, 'sk-or-secret');
    const raw = db.prepare('SELECT openrouter_key_enc FROM config WHERE user_id=?').get(uid) as any;
    expect(raw.openrouter_key_enc).not.toContain('sk-or-secret');
    expect(getOpenrouterKey(db, uid)).toBe('sk-or-secret');
  });

  it('returns undefined key when unset', () => {
    expect(getOpenrouterKey(db, uid)).toBeUndefined();
  });
});
