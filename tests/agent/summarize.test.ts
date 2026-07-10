import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { setOpenrouterKey } from '../../src/db/config.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { addMessage } from '../../src/db/messages.js';
import { maybeSummarize, getSummary } from '../../src/agent/summarize.js';

let db: DB, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
  setOpenrouterKey(db, uid, 'sk-or');
});

describe('maybeSummarize', () => {
  it('does nothing below the trigger threshold', async () => {
    for (let i = 0; i < 5; i++) addMessage(db, uid, 'user', `m${i}`);
    let called = false;
    await maybeSummarize({ db, appCfg: {} as any, generate: async () => { called = true; return { text: 's' }; } }, uid);
    expect(called).toBe(false);
    expect(getSummary(db, uid).summary).toBe('');
  });

  it('summarizes older half once over threshold and advances pointer', async () => {
    for (let i = 0; i < 40; i++) addMessage(db, uid, 'user', `m${i}`);
    await maybeSummarize({ db, appCfg: {} as any, generate: async () => ({ text: 'SUMMARY' }) }, uid);
    const s = getSummary(db, uid);
    expect(s.summary).toContain('SUMMARY');
    expect(s.last_summarized_msg_id).toBeGreaterThan(0);
  });
});
