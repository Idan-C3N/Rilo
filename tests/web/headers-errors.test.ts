import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { buildWebApp } from '../../src/web/server.js';
import { createUserWithIdentity, setAllowlisted } from '../../src/db/users.js';
import { startLogin, verifyByToken } from '../../src/db/sessions.js';

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

describe('error handler (L3)', () => {
  it('a 5xx returns a generic body and never echoes the internal error message', async () => {
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, u.id, true);
    const { token } = startLogin(db, u.id);
    const cookie = `token=${verifyByToken(db, token)}`;
    // An authed route that throws with a secret-bearing message.
    app.get('/__boom', async () => {
      throw new Error('SECRET-INTERNAL-DETAIL-xyz');
    });
    const res = await app.inject({ method: 'GET', url: '/__boom', headers: { cookie } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('SECRET-INTERNAL-DETAIL-xyz'); // internal message not leaked
    expect(res.body).toContain('Something went wrong.'); // generic message shown
  });
});
