import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import {
  createSpace, addMember, removeMember, isMember,
  listSpacesForUser, listMembers, getSpaceByName,
} from '../../src/db/spaces.js';

let db: DB, a: number, b: number;
beforeEach(() => {
  db = openDb(':memory:');
  a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 }).id;
  b = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', heartbeat_interval_min: 30 }).id;
});

describe('spaces repo', () => {
  it('createSpace makes the creator a member', () => {
    const s = createSpace(db, { name: 'Home', createdBy: a });
    expect(s.name).toBe('Home');
    expect(isMember(db, s.id, a)).toBe(true);
    expect(isMember(db, s.id, b)).toBe(false);
  });

  it('addMember is idempotent; removeMember drops', () => {
    const s = createSpace(db, { name: 'Home', createdBy: a });
    addMember(db, s.id, b);
    addMember(db, s.id, b); // no throw on duplicate
    expect(isMember(db, s.id, b)).toBe(true);
    removeMember(db, s.id, b);
    expect(isMember(db, s.id, b)).toBe(false);
  });

  it('listSpacesForUser returns only joined spaces', () => {
    const home = createSpace(db, { name: 'Home', createdBy: a });
    createSpace(db, { name: 'Work', createdBy: b });
    expect(listSpacesForUser(db, a).map((s) => s.name)).toEqual(['Home']);
    expect(listMembers(db, home.id).map((u) => u.id)).toEqual([a]);
  });

  it('getSpaceByName resolves within the caller\'s spaces, case-insensitive', () => {
    const s = createSpace(db, { name: 'Home', createdBy: a });
    expect(getSpaceByName(db, a, 'home')?.id).toBe(s.id);
    expect(getSpaceByName(db, b, 'Home')).toBeUndefined(); // b not a member
  });
});
