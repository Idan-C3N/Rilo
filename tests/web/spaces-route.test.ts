import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyByToken } from '../../src/db/sessions.js';
import { buildWebApp } from '../../src/web/server.js';
import { listSpacesForUser, isMember, createSpace } from '../../src/db/spaces.js';
import { remember } from '../../src/db/memory.js';
import { listActiveInvites } from '../../src/db/spaceInvites.js';

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

  it('GET /spaces shows a shared fact even when >50 newer visible rows exist', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    const space = createSpace(db, { name: 'Home', createdBy: a.id });
    remember(db, a.id, 'ancient shared fact', undefined, space.id);
    // 55 newer personal rows would push the old shared fact past recall()'s LIMIT 50.
    for (let i = 0; i < 55; i++) remember(db, a.id, `personal note ${i}`);

    const res = await app.inject({ method: 'GET', url: '/spaces', headers: { cookie: sessionFor(a.id) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ancient shared fact');
  });
});

describe('space invite codes (web)', () => {
  it('creating a space mints one active invite code shown on the page', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    await app.inject({ method: 'POST', url: '/spaces', headers: { cookie: sessionFor(a.id) }, payload: { name: 'Home' } });
    const space = listSpacesForUser(db, a.id)[0]!;
    const codes = listActiveInvites(db, space.id);
    expect(codes).toHaveLength(1);
    const res = await app.inject({ method: 'GET', url: '/spaces', headers: { cookie: sessionFor(a.id) } });
    expect(res.body).toContain(codes[0]!.code);
  });

  it('POST /spaces/:id/invite generates another code for a member', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    await app.inject({ method: 'POST', url: '/spaces', headers: { cookie: sessionFor(a.id) }, payload: { name: 'Home' } });
    const space = listSpacesForUser(db, a.id)[0]!;
    const res = await app.inject({ method: 'POST', url: `/spaces/${space.id}/invite`, headers: { cookie: sessionFor(a.id) } });
    expect(res.statusCode).toBe(302);
    expect(listActiveInvites(db, space.id).length).toBe(2); // create-mint + this one
  });

  it('POST /spaces/redeem joins the invitee via a code', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    const dana = createUserWithIdentity(db, { channel: 'telegram', externalId: 'dana', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    setAllowlisted(db, dana.id, true);
    await app.inject({ method: 'POST', url: '/spaces', headers: { cookie: sessionFor(a.id) }, payload: { name: 'Home' } });
    const space = listSpacesForUser(db, a.id)[0]!;
    const code = listActiveInvites(db, space.id)[0]!.code;
    const res = await app.inject({ method: 'POST', url: '/spaces/redeem', headers: { cookie: sessionFor(dana.id) }, payload: { code } });
    expect(res.statusCode).toBe(302);
    expect(isMember(db, space.id, dana.id)).toBe(true);
  });

  it('a non-member cannot generate a code for a space', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    const b = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    setAllowlisted(db, b.id, true);
    await app.inject({ method: 'POST', url: '/spaces', headers: { cookie: sessionFor(a.id) }, payload: { name: 'Home' } });
    const space = listSpacesForUser(db, a.id)[0]!;
    const before = listActiveInvites(db, space.id).length;
    await app.inject({ method: 'POST', url: `/spaces/${space.id}/invite`, headers: { cookie: sessionFor(b.id) } });
    expect(listActiveInvites(db, space.id).length).toBe(before); // no code minted for the non-member
  });

  it('does not leak other users names on the spaces page (no enumeration)', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    const secret = createUserWithIdentity(db, { channel: 'telegram', externalId: 'secret', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    setAllowlisted(db, secret.id, true);
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run('Zehava-Not-In-Space', secret.id);
    await app.inject({ method: 'POST', url: '/spaces', headers: { cookie: sessionFor(a.id) }, payload: { name: 'Home' } });
    const res = await app.inject({ method: 'GET', url: '/spaces', headers: { cookie: sessionFor(a.id) } });
    expect(res.body).not.toContain('Zehava-Not-In-Space'); // a non-member's name must never appear
  });
});
