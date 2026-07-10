import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { setOpenrouterKey } from '../../src/db/config.js';
import { resolveModels } from '../../src/agent/models.js';

const appCfg = { openrouterKeyFallback: undefined } as any;
let db: DB, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('resolveModels', () => {
  it('throws when no key available', () => {
    expect(() => resolveModels(db, appCfg, uid)).toThrow(/OpenRouter key/i);
  });

  it('returns cheap + strong models when a user key exists', () => {
    setOpenrouterKey(db, uid, 'sk-or-test');
    const m = resolveModels(db, appCfg, uid);
    expect(m.cheap).toBeDefined();
    expect(m.strong).toBeDefined();
  });
});
