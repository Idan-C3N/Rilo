import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyCode } from '../../src/db/sessions.js';
import { buildWebApp } from '../../src/web/server.js';

let db: DB, app: any, cookie: string;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(async () => {
  db = openDb(':memory:');
  const uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
  const { token, code } = startLogin(db, uid);
  verifyCode(db, token, code);
  cookie = `token=${token}`;
  app = await buildWebApp({ db, appCfg: {} as any });
});

describe('login + logout', () => {
  it('GET /login is public and shows the code form', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="code"');
    expect(res.body).toContain('Enter your code');
  });

  it('POST /login with a bad code shows a styled error flash (200)', async () => {
    // no valid token cookie -> failure branch
    const res = await app.inject({ method: 'POST', url: '/login', payload: { code: '000000' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('flash-error');
  });

  it('GET /logout clears the cookie and redirects to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/logout', headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
    const setCookie = String(res.headers['set-cookie'] ?? '');
    expect(setCookie).toMatch(/token=;|Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});
