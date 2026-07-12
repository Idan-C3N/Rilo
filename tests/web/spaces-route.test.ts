import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyByToken } from '../../src/db/sessions.js';
import { buildWebApp } from '../../src/web/server.js';
import { listSpacesForUser, isMember, createSpace } from '../../src/db/spaces.js';
import { remember } from '../../src/db/memory.js';

function factExists(id: number): boolean {
  return !!db.prepare('SELECT 1 FROM memory WHERE id = ?').get(id);
}

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

describe('Spaces web page', () => {
  it('POST /spaces creates a space owned/joined by the caller', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    const res = await app.inject({
      method: 'POST',
      url: '/spaces',
      headers: { cookie: sessionFor(a.id) },
      payload: { name: 'Home' },
    });
    expect(res.statusCode).toBe(302);
    const spaces = listSpacesForUser(db, a.id);
    expect(spaces.map((s) => s.name)).toContain('Home');
  });

  it('GET /spaces returns 200 and lists the space name', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    await app.inject({
      method: 'POST',
      url: '/spaces',
      headers: { cookie: sessionFor(a.id) },
      payload: { name: 'Home' },
    });
    const res = await app.inject({ method: 'GET', url: '/spaces', headers: { cookie: sessionFor(a.id) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Home');
  });

  it('POST /spaces/:id/members adds an allowlisted user as a member', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    const dana = createUserWithIdentity(db, { channel: 'telegram', externalId: 'dana', heartbeat_interval_min: 30 });
    setAllowlisted(db, dana.id, true);
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run('Dana', dana.id);

    const createRes = await app.inject({
      method: 'POST',
      url: '/spaces',
      headers: { cookie: sessionFor(a.id) },
      payload: { name: 'Home' },
    });
    expect(createRes.statusCode).toBe(302);
    const space = listSpacesForUser(db, a.id)[0]!;

    const res = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/members`,
      headers: { cookie: sessionFor(a.id) },
      payload: { member: 'Dana' },
    });
    expect(res.statusCode).toBe(302);
    expect(isMember(db, space.id, dana.id)).toBe(true);
  });

  it('POST /spaces/:id/leave removes the caller as a member', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    await app.inject({
      method: 'POST',
      url: '/spaces',
      headers: { cookie: sessionFor(a.id) },
      payload: { name: 'Home' },
    });
    const space = listSpacesForUser(db, a.id)[0]!;

    const res = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/leave`,
      headers: { cookie: sessionFor(a.id) },
    });
    expect(res.statusCode).toBe(302);
    expect(isMember(db, space.id, a.id)).toBe(false);
  });

  it('POST /spaces/:id/facts/:fid/delete removes a shared fact belonging to that space', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    const space = createSpace(db, { name: 'Home', createdBy: a.id });
    const fid = remember(db, a.id, 'kids pickup 15:30', undefined, space.id);
    expect(factExists(fid)).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/facts/${fid}/delete`,
      headers: { cookie: sessionFor(a.id) },
    });
    expect(res.statusCode).toBe(302);
    expect(factExists(fid)).toBe(false);
  });

  it('POST /spaces/:id/facts/:fid/delete cannot delete a fact from a different space', async () => {
    // Space A with a shared fact, owned by user a (member of A only).
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    const spaceA = createSpace(db, { name: 'A', createdBy: a.id });
    const fid = remember(db, a.id, 'A secret', undefined, spaceA.id);

    // Attacker b is a member of a DIFFERENT space B, not of A.
    const b = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', heartbeat_interval_min: 30 });
    setAllowlisted(db, b.id, true);
    const spaceB = createSpace(db, { name: 'B', createdBy: b.id });

    const res = await app.inject({
      method: 'POST',
      url: `/spaces/${spaceB.id}/facts/${fid}/delete`,
      headers: { cookie: sessionFor(b.id) },
    });
    expect(res.statusCode).toBe(302);
    // Cross-space delete must be a no-op: the fact still exists.
    expect(factExists(fid)).toBe(true);
  });

  it('POST /spaces/:id/facts/:fid/delete cannot delete a personal fact via a space route', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    const personalFid = remember(db, a.id, 'my personal note'); // space_id NULL
    const space = createSpace(db, { name: 'Home', createdBy: a.id });

    const res = await app.inject({
      method: 'POST',
      url: `/spaces/${space.id}/facts/${personalFid}/delete`,
      headers: { cookie: sessionFor(a.id) },
    });
    expect(res.statusCode).toBe(302);
    expect(factExists(personalFid)).toBe(true);
  });
});
