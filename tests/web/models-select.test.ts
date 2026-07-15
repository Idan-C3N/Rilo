import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyByToken } from '../../src/db/sessions.js';
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
  setAllowlisted(db, uid, true);
  const { token } = startLogin(db, uid);
  cookie = `token=${verifyByToken(db, token)}`;
});

const IDS = ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5'];

describe('models autocomplete (datalist)', () => {
  it('renders inputs bound to a datalist of catalog ids, current value in the input', async () => {
    setModels(db, uid, { cheap_model: 'anthropic/claude-haiku-4.5', strong_model: 'anthropic/claude-sonnet-5' });
    const app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => IDS });
    const res = await app.inject({ method: 'GET', url: '/models', headers: { cookie } });
    expect(res.body).toContain('<input name="cheap_model" value="anthropic/claude-haiku-4.5" list="model-list"');
    expect(res.body).toContain('<datalist id="model-list">');
    expect(res.body).toContain('<option value="anthropic/claude-sonnet-5"></option>');
  });

  it('keeps a stored value not in the catalog (input value), datalist is just suggestions', async () => {
    setModels(db, uid, { cheap_model: 'anthropic/deprecated-old', strong_model: 'anthropic/claude-sonnet-5' });
    const app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => IDS });
    const res = await app.inject({ method: 'GET', url: '/models', headers: { cookie } });
    expect(res.body).toContain('<input name="cheap_model" value="anthropic/deprecated-old" list="model-list"');
  });

  it('falls back to bare inputs (no datalist) when the catalog is empty', async () => {
    const app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => [] });
    const res = await app.inject({ method: 'GET', url: '/models', headers: { cookie } });
    expect(res.body).toContain('<input name="cheap_model" value=');
    expect(res.body).not.toContain('list="model-list"');
    expect(res.body).not.toContain('<datalist');
    expect(res.body).toContain("Couldn't load the model list");
  });
});
