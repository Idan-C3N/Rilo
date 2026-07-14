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
  it('create makes a space with the caller as member and returns an invite code', async () => {
    const t = makeSpacesTool(db, a);
    const res = await t.execute!({ action: 'create', name: 'Home' }, {} as any) as { ok: boolean; code?: string };
    expect(res.ok).toBe(true);
    expect(res.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(listSpacesForUser(db, a).map((s) => s.name)).toEqual(['Home']);
  });

  it('invite returns a code for a member; redeem joins the invitee', async () => {
    const ta = makeSpacesTool(db, a);
    await ta.execute!({ action: 'create', name: 'Home' }, {} as any);
    const inv = await ta.execute!({ action: 'invite', name: 'Home' }, {} as any) as { ok: boolean; code: string };
    expect(inv.ok).toBe(true);

    const tb = makeSpacesTool(db, b);
    const red = await tb.execute!({ action: 'redeem', code: inv.code }, {} as any) as { ok: boolean };
    expect(red.ok).toBe(true);
    const home = getSpaceByName(db, a, 'Home')!;
    expect(isMember(db, home.id, b)).toBe(true);
  });

  it('invite is refused when the caller is not a member of the space', async () => {
    const tb = makeSpacesTool(db, b);
    await tb.execute!({ action: 'create', name: 'Work' }, {} as any); // owned by b
    const ta = makeSpacesTool(db, a);
    const res = await ta.execute!({ action: 'invite', name: 'Work' }, {} as any) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it('redeem rejects an invalid code and joins nobody', async () => {
    const tb = makeSpacesTool(db, b);
    const res = await tb.execute!({ action: 'redeem', code: 'BADCOD' }, {} as any) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(listSpacesForUser(db, b)).toEqual([]);
  });

  it('leave removes the caller', async () => {
    const t = makeSpacesTool(db, a);
    await t.execute!({ action: 'create', name: 'Home' }, {} as any);
    const res = await t.execute!({ action: 'leave', name: 'Home' }, {} as any) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(listSpacesForUser(db, a)).toEqual([]);
  });
});
