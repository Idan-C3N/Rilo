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
  app = await buildWebApp({ db, appCfg: {} as any });
});

describe('security headers', () => {
  it('responses carry CSP + HSTS + nosniff headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.headers['content-security-policy']).toBeTruthy();
    expect(res.headers['strict-transport-security']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('CSP allows self scripts + inline styles (so htmx + inline <style> work)', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toMatch(/script-src[^;]*'self'/);
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
  });
});
