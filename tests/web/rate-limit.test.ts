import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { buildWebApp } from '../../src/web/server.js';

let db: DB, app: any;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildWebApp({
    db,
    appCfg: {} as any,
    registrationLink: (code: string) => `https://t.me/rilo_bot?start=${code}`,
  });
});

describe('rate limiting', () => {
  it('POST /register is rate-limited (429 after the cap)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({ method: 'POST', url: '/register', payload: { name: 'x', phone: '123' } });
      codes.push(res.statusCode);
    }
    expect(codes).toContain(429); // cap is 5/min → later requests rejected
  });
});
