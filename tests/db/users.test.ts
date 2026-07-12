import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import {
  createUserWithIdentity,
  getUserByIdentity,
  getExternalId,
  isAllowlisted,
  setAllowlisted,
  setOwner,
  isOwner,
  ensureOwner,
} from '../../src/db/users.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('users repo', () => {
  it('creates a user with a linked identity, round-trips via getUserByIdentity', () => {
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: '123', name: 'Ann', heartbeat_interval_min: 30 });
    expect(u.id).toBeGreaterThan(0);
    expect(getUserByIdentity(db, 'telegram', '123')?.id).toBe(u.id);
  });

  it('is not allowlisted by default and has a config row', () => {
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: '9', name: 'B', heartbeat_interval_min: 30 });
    expect(isAllowlisted(db, u.id)).toBe(false);
    const cfg = db.prepare('SELECT * FROM config WHERE user_id=?').get(u.id) as any;
    expect(cfg.cheap_model).toContain('haiku');
  });

  it('setAllowlisted flips isAllowlisted', () => {
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: '9', heartbeat_interval_min: 30 });
    setAllowlisted(db, u.id, true);
    expect(isAllowlisted(db, u.id)).toBe(true);
  });

  it('getUserByIdentity returns undefined for an unknown identity', () => {
    expect(getUserByIdentity(db, 'telegram', 'nope')).toBeUndefined();
  });

  it('getExternalId returns the linked external id for a channel', () => {
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: 'tg', name: 'C', heartbeat_interval_min: 15 });
    expect(getExternalId(db, u.id, 'telegram')).toBe('tg');
    expect(getExternalId(db, u.id, 'whatsapp')).toBeUndefined();
  });

  it('setOwner / isOwner round-trip; not an owner by default', () => {
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: '9', heartbeat_interval_min: 30 });
    expect(isOwner(db, u.id)).toBe(false);
    setOwner(db, u.id, true);
    expect(isOwner(db, u.id)).toBe(true);
  });

  it('ensureOwner creates, allowlists and marks the owner', () => {
    const u = ensureOwner(db, '4242');
    expect(getUserByIdentity(db, 'telegram', '4242')?.id).toBe(u.id);
    expect(isAllowlisted(db, u.id)).toBe(true);
    expect(isOwner(db, u.id)).toBe(true);
  });

  it('ensureOwner is idempotent — no duplicate user on second call', () => {
    const first = ensureOwner(db, '4242');
    const second = ensureOwner(db, '4242');
    expect(second.id).toBe(first.id);
    const count = (db.prepare('SELECT COUNT(*) c FROM users').get() as any).c;
    expect(count).toBe(1);
  });
});
