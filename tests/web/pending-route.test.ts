import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted, setOwner, isAllowlisted } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyByToken } from '../../src/db/sessions.js';
import { buildWebApp } from '../../src/web/server.js';
import { createRegistration, bindRequester, markPendingApproval, findByCode } from '../../src/db/registrations.js';

let db: DB, app: any;
const notified: any[] = [];

function sessionFor(userId: number): string {
  const { token } = startLogin(db, userId);
  return `token=${verifyByToken(db, token)}`;
}

/** Seed a pending registration bound to a fresh requester; return the requester id. */
function seedPending(externalId: string, name = 'Ann', phone = '972501234567'): number {
  const reg = createRegistration(db, { name, phone });
  const u = createUserWithIdentity(db, { channel: 'telegram', externalId, heartbeat_interval_min: 30 });
  bindRequester(db, reg.id, externalId, u.id);
  markPendingApproval(db, reg.id);
  return u.id;
}

beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(async () => {
  db = openDb(':memory:');
  notified.length = 0;
  app = await buildWebApp({
    db,
    appCfg: {} as any,
    registrationLink: (code: string) => `https://t.me/rilo_bot?start=${code}`,
    notify: async (channelUserId: string, text: string) => { notified.push([channelUserId, text]); },
  });
});

describe('owner-only Pending list', () => {
  it('GET /users/pending is 403 for a non-owner', async () => {
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: 'nonowner', heartbeat_interval_min: 30 });
    setAllowlisted(db, u.id, true);
    const res = await app.inject({ method: 'GET', url: '/users/pending', headers: { cookie: sessionFor(u.id) } });
    expect(res.statusCode).toBe(403);
  });

  it('GET /users/pending lists pending requests for the owner', async () => {
    seedPending('req1', 'Ann');
    const owner = createUserWithIdentity(db, { channel: 'telegram', externalId: 'owner', heartbeat_interval_min: 30 });
    setOwner(db, owner.id, true);
    const res = await app.inject({ method: 'GET', url: '/users/pending', headers: { cookie: sessionFor(owner.id) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Ann');
    expect(res.body).toContain('/approve');
  });

  it('POST /users/:id/approve is 403 for a non-owner and does not allowlist', async () => {
    const targetId = seedPending('req1');
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: 'nonowner', heartbeat_interval_min: 30 });
    setAllowlisted(db, u.id, true);
    const res = await app.inject({ method: 'POST', url: `/users/${targetId}/approve`, headers: { cookie: sessionFor(u.id) } });
    expect(res.statusCode).toBe(403);
    expect(isAllowlisted(db, targetId)).toBe(false);
  });

  it('POST /users/:id/approve by the owner allowlists, marks approved, and notifies', async () => {
    const targetId = seedPending('req1');
    const owner = createUserWithIdentity(db, { channel: 'telegram', externalId: 'owner', heartbeat_interval_min: 30 });
    setOwner(db, owner.id, true);
    const res = await app.inject({ method: 'POST', url: `/users/${targetId}/approve`, headers: { cookie: sessionFor(owner.id) } });
    expect(res.statusCode).toBe(302);
    expect(isAllowlisted(db, targetId)).toBe(true);
    expect(notified.some((n) => n[0] === 'req1')).toBe(true);
  });

  it('POST /users/:id/deny by the owner marks denied and leaves un-allowlisted', async () => {
    const targetId = seedPending('req1');
    const owner = createUserWithIdentity(db, { channel: 'telegram', externalId: 'owner', heartbeat_interval_min: 30 });
    setOwner(db, owner.id, true);
    const res = await app.inject({ method: 'POST', url: `/users/${targetId}/deny`, headers: { cookie: sessionFor(owner.id) } });
    expect(res.statusCode).toBe(302);
    expect(isAllowlisted(db, targetId)).toBe(false);
    const rows = db.prepare('SELECT * FROM pending_registrations').all() as any[];
    expect(rows[0].status).toBe('denied');
  });
});
