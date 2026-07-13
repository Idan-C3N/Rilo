import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyByToken } from '../../src/db/sessions.js';
import { buildWebApp } from '../../src/web/server.js';
import { addJob, listRecurring } from '../../src/db/jobs.js';

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
    db, appCfg: {} as any,
    registrationLink: (code: string) => `https://t.me/rilo_bot?start=${code}`,
    notify: async () => {},
  });
});

describe('Reminders web page', () => {
  it('GET /reminders lists the caller active recurring reminders', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    addJob(db, { userId: a.id, type: 'reminder', fireAt: 5000, payload: { text: 'standup' }, recurrence: '0 9 * * 1' });
    const res = await app.inject({ method: 'GET', url: '/reminders', headers: { cookie: sessionFor(a.id) } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('standup');
    expect(res.body).toContain('0 9 * * 1');
  });

  it('POST /reminders/:id/cancel cancels a caller-owned reminder', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    const id = addJob(db, { userId: a.id, type: 'reminder', fireAt: 5000, payload: {}, recurrence: '0 9 * * 1' });
    const res = await app.inject({ method: 'POST', url: `/reminders/${id}/cancel`, headers: { cookie: sessionFor(a.id) } });
    expect(res.statusCode).toBe(302);
    expect(listRecurring(db, a.id)).toHaveLength(0);
  });

  it('POST /reminders/:id/cancel does not cancel another user reminder', async () => {
    const a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 });
    const b = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', heartbeat_interval_min: 30 });
    setAllowlisted(db, a.id, true);
    const id = addJob(db, { userId: b.id, type: 'reminder', fireAt: 5000, payload: {}, recurrence: '0 9 * * 1' });
    await app.inject({ method: 'POST', url: `/reminders/${id}/cancel`, headers: { cookie: sessionFor(a.id) } });
    expect(listRecurring(db, b.id)).toHaveLength(1); // untouched
  });
});
