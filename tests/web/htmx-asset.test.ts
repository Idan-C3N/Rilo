import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { buildWebApp } from '../../src/web/server.js';
import { layout } from '../../src/web/render.js';

let db: DB, app: any;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
  db = openDb(':memory:');
  app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => [] });
});

describe('htmx asset', () => {
  it('serves the vendored htmx script without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/vendor/htmx.min.js' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('javascript');
    expect(res.body.length).toBeGreaterThan(1000);
    expect(res.body).toContain('htmx');
  });

  it('layout loads the htmx script tag', () => {
    expect(layout('X', '')).toContain('<script src="/vendor/htmx.min.js" defer></script>');
  });
});
