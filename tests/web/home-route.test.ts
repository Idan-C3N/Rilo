import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyByToken } from '../../src/db/sessions.js';
import { buildWebApp } from '../../src/web/server.js';

let db: DB, uid: number, app: any, cookie: string;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(async () => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
  const { token } = startLogin(db, uid);
  cookie = `token=${verifyByToken(db, token)}`;
  app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5'] });
});

describe('home dashboard + models relocation', () => {
  it('authed GET / renders the getting-started checklist', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Getting started');
    expect(res.body).toContain('OpenRouter key');
    expect(res.body).toContain('Services');
  });

  it('GET /models renders the model config screen', async () => {
    const res = await app.inject({ method: 'GET', url: '/models', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Cheap model');
    expect(res.body).toContain('Strong model');
  });

  it('POST /models redirects with a saved flash param', async () => {
    const res = await app.inject({
      method: 'POST', url: '/models', headers: { cookie },
      payload: { cheap_model: 'a/b', strong_model: 'c/d' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/models?saved=models');
  });

  it('GET /models?saved=models shows a success flash', async () => {
    const res = await app.inject({ method: 'GET', url: '/models?saved=models', headers: { cookie } });
    expect(res.body).toContain('flash-ok');
  });
});
