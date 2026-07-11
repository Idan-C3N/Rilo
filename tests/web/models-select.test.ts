import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyCode } from '../../src/db/sessions.js';
import { setModels } from '../../src/db/config.js';
import { buildWebApp } from '../../src/web/server.js';

let db: DB, uid: number, cookie: string;
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
});

const IDS = ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5'];

describe('models <select>', () => {
  it('renders selects populated from the catalog with the current value selected', async () => {
    setModels(db, uid, { cheap_model: 'anthropic/claude-haiku-4.5', strong_model: 'anthropic/claude-sonnet-5' });
    const app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => IDS });
    const res = await app.inject({ method: 'GET', url: '/models', headers: { cookie } });
    expect(res.body).toContain('<select name="cheap_model">');
    expect(res.body).toContain('<option value="anthropic/claude-haiku-4.5" selected>');
  });

  it('keeps a stored value not in the catalog by prepending it, still selected', async () => {
    setModels(db, uid, { cheap_model: 'anthropic/deprecated-old', strong_model: 'anthropic/claude-sonnet-5' });
    const app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => IDS });
    const res = await app.inject({ method: 'GET', url: '/models', headers: { cookie } });
    expect(res.body).toContain('<option value="anthropic/deprecated-old" selected>');
  });

  it('falls back to free-text inputs when the catalog is empty', async () => {
    const app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => [] });
    const res = await app.inject({ method: 'GET', url: '/models', headers: { cookie } });
    expect(res.body).toContain('<input name="cheap_model"');
    expect(res.body).toContain("Couldn't load the model list");
  });
});
