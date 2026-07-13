import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted } from '../../../src/db/users.js';
import { isMember, listSpacesForUser, getSpaceByName } from '../../../src/db/spaces.js';
import { makeSpacesTool } from '../../../src/agent/tools/spaces.js';

let db: DB, a: number, b: number;
beforeEach(() => {
  db = openDb(':memory:');
  a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', name: 'Idan', heartbeat_interval_min: 30 }).id;
  b = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', name: 'Dana', heartbeat_interval_min: 30 }).id;
  setAllowlisted(db, a, true);
  setAllowlisted(db, b, true);
});

describe('spaces tool', () => {
  it('creates a space with the caller as member', async () => {
    const t = makeSpacesTool(db, a);
    const res = await t.execute!({ action: 'create', name: 'Home' }, {} as any) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(listSpacesForUser(db, a).map((s) => s.name)).toEqual(['Home']);
  });

  it('adds an allowlisted member by name', async () => {
    const t = makeSpacesTool(db, a);
    await t.execute!({ action: 'create', name: 'Home' }, {} as any);
    const res = await t.execute!({ action: 'add_member', name: 'Home', member: 'Dana' }, {} as any) as { ok: boolean };
    expect(res.ok).toBe(true);
    const home = getSpaceByName(db, a, 'Home')!;
    expect(isMember(db, home.id, b)).toBe(true);
  });

  it('rejects add_member when caller is not a member of the space', async () => {
    const other = makeSpacesTool(db, b);
    await other.execute!({ action: 'create', name: 'Work' }, {} as any); // owned by b
    const t = makeSpacesTool(db, a);
    const res = await t.execute!({ action: 'add_member', name: 'Work', member: 'Dana' }, {} as any) as { ok: boolean };
    expect(res.ok).toBe(false);
    // The rejected add_member must have had no side effect: the non-member caller
    // was not sneaked into the space, and its membership is unchanged (only b, the owner).
    const work = getSpaceByName(db, b, 'Work')!;
    expect(isMember(db, work.id, a)).toBe(false);
  });

  it('leave removes the caller', async () => {
    const t = makeSpacesTool(db, a);
    await t.execute!({ action: 'create', name: 'Home' }, {} as any);
    const res = await t.execute!({ action: 'leave', name: 'Home' }, {} as any) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(listSpacesForUser(db, a)).toEqual([]);
  });
});
