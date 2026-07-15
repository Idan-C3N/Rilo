import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyByToken } from '../../src/db/sessions.js';
import { buildWebApp } from '../../src/web/server.js';

let db: DB, app: any, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(async () => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
  app = await buildWebApp({ db, appCfg: {} as any });
});

describe('magic-link login', () => {
  it('GET /login (no token) shows the "check Telegram" page, no form', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Check Telegram');
    expect(res.body).not.toContain('name="code"');
  });

  it('GET /login?token=valid verifies, sets a rotated cookie, redirects to /', async () => {
    const { token } = startLogin(db, uid);
    const res = await app.inject({ method: 'GET', url: `/login?token=${token}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const setCookie = String(res.headers['set-cookie'] ?? '');
    expect(setCookie).toContain('token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    // Rotated: the cookie value is NOT the URL token.
    expect(setCookie).not.toContain(`token=${token};`);
  });

  it('GET /login?token=bad shows an error page and sets no session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/login?token=deadbeef' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('flash-error');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a used link token cannot be replayed', async () => {
    const { token } = startLogin(db, uid);
    await app.inject({ method: 'GET', url: `/login?token=${token}` }); // first use
    const res = await app.inject({ method: 'GET', url: `/login?token=${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('flash-error');
  });

  it('POST /login is gone (404)', async () => {
    const res = await app.inject({ method: 'POST', url: '/login', payload: { code: '000000' } });
    expect(res.statusCode).toBe(404);
  });

  it('POST /logout clears the cookie and redirects to /login', async () => {
    setAllowlisted(db, uid, true);
    const { token } = startLogin(db, uid);
    const cookie = `token=${verifyByToken(db, token)}`;
    const res = await app.inject({ method: 'POST', url: '/logout', headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
    const setCookie = String(res.headers['set-cookie'] ?? '');
    expect(setCookie).toMatch(/token=;|Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});
