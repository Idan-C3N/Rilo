import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyByToken } from '../../src/db/sessions.js';
import { buildWebApp } from '../../src/web/server.js';

let db: DB, app: any;

function sessionFor(userId: number): string {
  const { token } = startLogin(db, userId);
  return `token=${verifyByToken(db, token)}`;
}

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
    notify: async () => {},
  });
});

describe('Auth hardening', () => {
  it('session cookie is Secure + HttpOnly', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    const { token } = startLogin(db, a.id);
    const res = await app.inject({ method: 'GET', url: `/login?token=${token}` });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/HttpOnly/);
  });

  it('a de-allowlisted user with a valid session is redirected to /login', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    const cookie = sessionFor(a.id);
    expect((await app.inject({ method: 'GET', url: '/', headers: { cookie } })).statusCode).toBe(200);
    setAllowlisted(db, a.id, false);
    const res = await app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('logout is POST-only (GET no longer clears the session)', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    const cookie = sessionFor(a.id);
    expect((await app.inject({ method: 'GET', url: '/logout', headers: { cookie } })).statusCode).toBe(404);
    const res = await app.inject({ method: 'POST', url: '/logout', headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect(res.headers['set-cookie']).toBeTruthy(); // clearCookie emits a Set-Cookie that expires the token
  });
});
