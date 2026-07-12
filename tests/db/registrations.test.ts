import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import {
  normalizePhone,
  phoneMatches,
  createRegistration,
  findByCode,
  bindRequester,
  findAwaitingContact,
  markPendingApproval,
  findPendingByUserId,
  listPending,
  approve,
  deny,
} from '../../src/db/registrations.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('normalizePhone', () => {
  it('strips all non-digits', () => {
    expect(normalizePhone('+972-50-123 4567')).toBe('972501234567');
    expect(normalizePhone('(054) 987.6543')).toBe('0549876543');
  });
});

describe('phoneMatches', () => {
  it('matches across +972… and 05… representations (last 8)', () => {
    expect(phoneMatches('+972501234567', '0501234567')).toBe(true);
    expect(phoneMatches('972-50-123-4567', '050 1234567')).toBe(true);
  });
  it('rejects a genuinely different number', () => {
    expect(phoneMatches('+972501234567', '+972509999999')).toBe(false);
  });
  it('is false when either side has no digits', () => {
    expect(phoneMatches('', '0501234567')).toBe(false);
    expect(phoneMatches('abc', '0501234567')).toBe(false);
  });
});

describe('registration lifecycle', () => {
  it('creates with an unguessable code and awaiting_start status', () => {
    const r = createRegistration(db, { name: 'Ann', phone: '972501234567' });
    expect(r.status).toBe('awaiting_start');
    expect(r.code).toMatch(/\S{8,}/);
    expect(r.expires_at).toBeGreaterThan(Date.now());
    expect(findByCode(db, r.code)?.id).toBe(r.id);
  });

  it('binds a requester and moves to awaiting_contact', () => {
    const r = createRegistration(db, { name: 'Ann', phone: '972501234567' });
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: '77', heartbeat_interval_min: 30 });
    bindRequester(db, r.id, '77', u.id);
    const found = findAwaitingContact(db, 'telegram', '77');
    expect(found?.id).toBe(r.id);
    expect(found?.status).toBe('awaiting_contact');
    expect(found?.user_id).toBe(u.id);
    expect(found?.channel_user_id).toBe('77');
  });

  it('does not return awaiting_contact rows once pending', () => {
    const r = createRegistration(db, { name: 'Ann', phone: '972501234567' });
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: '77', heartbeat_interval_min: 30 });
    bindRequester(db, r.id, '77', u.id);
    markPendingApproval(db, r.id);
    expect(findAwaitingContact(db, 'telegram', '77')).toBeUndefined();
    expect(findPendingByUserId(db, u.id)?.id).toBe(r.id);
    expect(listPending(db).map((p) => p.id)).toEqual([r.id]);
  });

  it('approve / deny move to terminal states and drop from pending', () => {
    const r = createRegistration(db, { name: 'Ann', phone: '972501234567' });
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: '77', heartbeat_interval_min: 30 });
    bindRequester(db, r.id, '77', u.id);
    markPendingApproval(db, r.id);
    approve(db, r.id);
    expect(findByCode(db, r.code)?.status).toBe('approved');
    expect(findPendingByUserId(db, u.id)).toBeUndefined();
    expect(listPending(db)).toEqual([]);

    const r2 = createRegistration(db, { name: 'Bob', phone: '972509999999' });
    const u2 = createUserWithIdentity(db, { channel: 'telegram', externalId: '88', heartbeat_interval_min: 30 });
    bindRequester(db, r2.id, '88', u2.id);
    markPendingApproval(db, r2.id);
    deny(db, r2.id);
    expect(findByCode(db, r2.code)?.status).toBe('denied');
    expect(findPendingByUserId(db, u2.id)).toBeUndefined();
  });
});
