import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyCode } from '../../src/db/sessions.js';
import { getConfig } from '../../src/db/config.js';
import { buildWebApp } from '../../src/web/server.js';

let db: DB, uid: number, app: any, cookie: string;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(async () => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
  const { token, code } = startLogin(db, uid);
  verifyCode(db, token, code);
  cookie = `token=${token}`;
  app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5'] });
});

describe('models route', () => {
  it('redirects unauthenticated users to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('updates the strong model for an authenticated user', async () => {
    const res = await app.inject({
      method: 'POST', url: '/models', headers: { cookie },
      payload: { strong_model: 'anthropic/claude-3.7-sonnet', cheap_model: 'anthropic/claude-3.5-haiku' },
    });
    expect(res.statusCode).toBe(302);
    expect(getConfig(db, uid).strong_model).toBe('anthropic/claude-3.7-sonnet');
  });
});
