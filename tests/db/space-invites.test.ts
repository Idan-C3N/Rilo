import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { createSpace, isMember } from '../../src/db/spaces.js';
import {
  createInvite, getValidInvite, redeemInvite, listActiveInvites,
} from '../../src/db/spaceInvites.js';

let db: DB, owner: number, joiner: number, spaceId: number;
beforeEach(() => {
  db = openDb(':memory:');
  owner = createUserWithIdentity(db, { channel: 'telegram', externalId: 'o', heartbeat_interval_min: 30 }).id;
  joiner = createUserWithIdentity(db, { channel: 'telegram', externalId: 'j', heartbeat_interval_min: 30 }).id;
  spaceId = createSpace(db, { name: 'Home', createdBy: owner }).id;
});

it('createInvite returns a 6-char code from the unambiguous alphabet', () => {
  const { code } = createInvite(db, { spaceId, createdBy: owner });
  expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
});

it('getValidInvite returns a fresh code and rejects expired ones', () => {
  const { code } = createInvite(db, { spaceId, createdBy: owner });
  expect(getValidInvite(db, code)?.space_id).toBe(spaceId);
  const { code: dead } = createInvite(db, { spaceId, createdBy: owner, ttlMs: -1000 }); // already expired
  expect(getValidInvite(db, dead)).toBeUndefined();
  expect(getValidInvite(db, 'NOPE99')).toBeUndefined();
});

it('redeemInvite joins the space, marks the code used, and is single-use', () => {
  const { code } = createInvite(db, { spaceId, createdBy: owner });
  const r = redeemInvite(db, code, joiner);
  expect(r).toEqual({ ok: true, spaceId });
  expect(isMember(db, spaceId, joiner)).toBe(true);
  expect(getValidInvite(db, code)).toBeUndefined();          // consumed
  const again = redeemInvite(db, code, joiner);
  expect(again.ok).toBe(false);                              // single-use
});

it('redeemInvite rejects an invalid or expired code without joining', () => {
  expect(redeemInvite(db, 'BADCOD', joiner).ok).toBe(false);
  const { code: dead } = createInvite(db, { spaceId, createdBy: owner, ttlMs: -1000 });
  expect(redeemInvite(db, dead, joiner).ok).toBe(false);
  expect(isMember(db, spaceId, joiner)).toBe(false);
});

it('listActiveInvites excludes redeemed and expired codes', () => {
  const { code: live } = createInvite(db, { spaceId, createdBy: owner });
  const { code: used } = createInvite(db, { spaceId, createdBy: owner });
  createInvite(db, { spaceId, createdBy: owner, ttlMs: -1000 });  // expired
  redeemInvite(db, used, joiner);
  const active = listActiveInvites(db, spaceId).map((i) => i.code);
  expect(active).toEqual([live]);
});
