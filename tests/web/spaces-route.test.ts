import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyByToken } from '../../src/db/sessions.js';
import { buildWebApp } from '../../src/web/server.js';
import { listSpacesForUser, isMember } from '../../src/db/spaces.js';

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
});
