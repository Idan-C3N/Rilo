import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { buildWebApp } from '../../src/web/server.js';
import { listPending } from '../../src/db/registrations.js';

let db: DB, app: any;
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
  });
});

describe('public /register', () => {
  it('GET /register is public (200, no auth) and shows a form', async () => {
    const res = await app.inject({ method: 'GET', url: '/register' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="name"');
    expect(res.body).toContain('name="phone"');
  });

  it('POST /register creates a pending registration and shows a t.me deep link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { name: 'Ann', phone: '+972 50-123-4567' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/https:\/\/t\.me\/rilo_bot\?start=/);
    const rows = db.prepare('SELECT * FROM pending_registrations').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('Ann');
    expect(rows[0].phone).toBe('972501234567'); // normalized
    expect(rows[0].status).toBe('awaiting_start');
  });

  it('POST /register with missing fields re-renders with an error and creates nothing', async () => {
    const res = await app.inject({ method: 'POST', url: '/register', payload: { name: '', phone: '' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('flash-error');
    expect(db.prepare('SELECT COUNT(*) c FROM pending_registrations').get() as any).toEqual({ c: 0 });
    expect(listPending(db)).toEqual([]);
  });
});
