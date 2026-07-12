import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyByToken } from '../../src/db/sessions.js';
import { hasOAuthToken, getOAuthToken } from '../../src/db/oauth.js';
import { buildWebApp } from '../../src/web/server.js';
import type { MakeOauthClient } from '../../src/web/routes/oauth.js';

let db: DB, uid: number, cookie: string;
const ENC_KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32 zero bytes, base64

beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});

beforeEach(async () => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
  const { token } = startLogin(db, uid);
  cookie = `token=${verifyByToken(db, token)}`;
});

/** Fake Google client factory: real generateAuthUrl shape, stubbed getToken. */
function fakeMakeClient(getToken: MakeOauthClient extends never ? never : any): MakeOauthClient {
  return () => ({
    generateAuthUrl: (opts) =>
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=c&redirect_uri=${encodeURIComponent(
        'https://rilo.example/oauth/google/callback',
      )}&scope=${encodeURIComponent(opts.scope.join(' '))}&access_type=${opts.access_type}&prompt=${opts.prompt}&state=${opts.state}`,
    getToken,
  });
}

async function buildApp(opts: {
  enableWebOauth?: boolean;
  getToken?: (code: string) => Promise<{ tokens: { refresh_token?: string | null } }>;
}) {
  const getToken = opts.getToken ?? (async () => ({ tokens: { refresh_token: '1//web-refresh' } }));
  return buildWebApp({
    db,
    appCfg: {
      encKey: ENC_KEY_B64,
      webBaseUrl: 'https://rilo.example',
      googleClientId: 'c',
      googleClientSecret: 's',
      enableWebOauth: opts.enableWebOauth ?? true,
    } as any,
    makeOauthClient: fakeMakeClient(getToken),
  } as any);
}

/** Extract the raw `oauth_state=...` cookie pair from a start response's Set-Cookie. */
function stateCookie(res: any): string {
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : [raw];
  const sc = arr.find((c: string) => c.startsWith('oauth_state='))!;
  return sc.split(';')[0]!;
}

describe('GET /oauth/google/start', () => {
  it('redirects to Google consent with state, redirect_uri, scopes and sets a signed short-lived cookie', async () => {
    const app = await buildApp({ enableWebOauth: true });
    const res = await app.inject({ method: 'GET', url: '/oauth/google/start', headers: { cookie } });
    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain('accounts.google.com');
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(loc).toContain(encodeURIComponent('https://rilo.example/oauth/google/callback'));
    expect(loc).toContain('gmail.modify');
    expect(loc).toContain('calendar');
    // cookie hardening
    const raw = res.headers['set-cookie'];
    const sc = (Array.isArray(raw) ? raw.join(';') : raw) as string;
    expect(sc).toContain('oauth_state=');
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Max-Age=600\b/);
  });

  it('is inert when the flag is off (no cookie, redirect to /mcp)', async () => {
    const app = await buildApp({ enableWebOauth: false });
    const res = await app.inject({ method: 'GET', url: '/oauth/google/start', headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/mcp');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('GET /oauth/google/callback', () => {
  it('with matching state + a returned refresh token stores it for the initiating user and redirects', async () => {
    const app = await buildApp({ enableWebOauth: true });
    const start = await app.inject({ method: 'GET', url: '/oauth/google/start', headers: { cookie } });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/google/callback?code=abc&state=${state}`,
      headers: { cookie: stateCookie(start) },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/mcp?saved=google');
    expect(hasOAuthToken(db, uid, 'google')).toBe(true);
    expect(getOAuthToken(db, uid, 'google')).toBe('1//web-refresh');
    // state cookie cleared
    const raw = res.headers['set-cookie'];
    const sc = (Array.isArray(raw) ? raw.join(';') : raw) as string;
    expect(sc).toMatch(/oauth_state=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it('rejects a missing state cookie without storing a token', async () => {
    const app = await buildApp({ enableWebOauth: true });
    const res = await app.inject({ method: 'GET', url: '/oauth/google/callback?code=abc&state=whatever' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/mcp?error=');
    expect(hasOAuthToken(db, uid, 'google')).toBe(false);
  });

  it('rejects a mismatched state without storing a token', async () => {
    const app = await buildApp({ enableWebOauth: true });
    const start = await app.inject({ method: 'GET', url: '/oauth/google/start', headers: { cookie } });
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/google/callback?code=abc&state=TAMPERED`,
      headers: { cookie: stateCookie(start) },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/mcp?error=');
    expect(hasOAuthToken(db, uid, 'google')).toBe(false);
  });

  it('is inert when the flag is off (no token stored even with a code)', async () => {
    const app = await buildApp({ enableWebOauth: false });
    const res = await app.inject({ method: 'GET', url: '/oauth/google/callback?code=abc&state=x' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/mcp');
    expect(hasOAuthToken(db, uid, 'google')).toBe(false);
  });

  it('when Google returns no refresh_token, shows an error flash and stores nothing', async () => {
    const app = await buildApp({ enableWebOauth: true, getToken: async () => ({ tokens: {} }) });
    const start = await app.inject({ method: 'GET', url: '/oauth/google/start', headers: { cookie } });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/google/callback?code=abc&state=${state}`,
      headers: { cookie: stateCookie(start) },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/mcp?error=');
    expect(hasOAuthToken(db, uid, 'google')).toBe(false);
  });

  it('when the token exchange throws, returns a generic redirect with no stack trace and stores nothing', async () => {
    const app = await buildApp({
      enableWebOauth: true,
      getToken: async () => {
        throw new Error('boom secret internal detail');
      },
    });
    const start = await app.inject({ method: 'GET', url: '/oauth/google/start', headers: { cookie } });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/google/callback?code=abc&state=${state}`,
      headers: { cookie: stateCookie(start) },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/mcp?error=');
    expect(res.body).not.toContain('boom secret internal detail');
    expect(hasOAuthToken(db, uid, 'google')).toBe(false);
  });
});
