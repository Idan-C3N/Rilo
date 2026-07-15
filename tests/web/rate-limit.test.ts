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

  it('rate limits are keyed per-client via X-Forwarded-For, not shared across clients', async () => {
    const clientACodes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/register',
        headers: { 'x-forwarded-for': '1.1.1.1' },
        payload: { name: 'x', phone: '123' },
      });
      clientACodes.push(res.statusCode);
    }
    expect(clientACodes).toContain(429); // client A tripped the 5/min cap

    const clientBRes = await app.inject({
      method: 'POST',
      url: '/register',
      headers: { 'x-forwarded-for': '2.2.2.2' },
      payload: { name: 'y', phone: '456' },
    });
    expect(clientBRes.statusCode).toBeLessThan(429); // client B unaffected
  });

  it('a forged leftmost X-Forwarded-For cannot escape the bucket (trustProxy: 1)', async () => {
    // Caddy appends the real peer, so the header arrives as `<client-forged>, <realIP>`.
    // With trustProxy:1 the real (rightmost) IP is used, so rotating the forged
    // leftmost value must NOT create fresh buckets — the attacker stays throttled.
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/register',
        headers: { 'x-forwarded-for': `9.9.9.${i}, 5.5.5.5` }, // fake leftmost varies; real peer constant
        payload: { name: 'x', phone: '123' },
      });
      codes.push(res.statusCode);
    }
    expect(codes).toContain(429); // all keyed to 5.5.5.5 despite the rotating fake → still capped
  });
});
