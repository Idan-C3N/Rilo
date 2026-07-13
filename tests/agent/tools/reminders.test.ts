import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUserWithIdentity } from '../../../src/db/users.js';
import { addJob, listRecurring } from '../../../src/db/jobs.js';
import { makeListRemindersTool, makeCancelReminderTool } from '../../../src/agent/tools/reminders.js';

let db: DB, uid: number, other: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 }).id;
  other = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', heartbeat_interval_min: 30 }).id;
});

it('list_reminders returns the caller active recurring reminders', async () => {
  addJob(db, { userId: uid, type: 'reminder', fireAt: 5000, payload: { text: 'standup' }, recurrence: '0 9 * * 1', recurrenceCount: 3 });
  addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} }); // one-shot excluded
  addJob(db, { userId: other, type: 'reminder', fireAt: 5000, payload: { text: 'x' }, recurrence: '0 9 * * 1' }); // other user excluded
  const res: any = await makeListRemindersTool(db, uid).execute!({} as any, {} as any);
  expect(res.reminders).toHaveLength(1);
  expect(res.reminders[0]).toMatchObject({ schedule: '0 9 * * 1', text: 'standup', remaining: 3 });
});

it('cancel_reminder cancels a caller-owned reminder', async () => {
  const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 5000, payload: {}, recurrence: '0 9 * * 1' });
  const res: any = await makeCancelReminderTool(db, uid).execute!({ id } as any, {} as any);
  expect(res.ok).toBe(true);
  expect(listRecurring(db, uid)).toHaveLength(0);
});

it('cancel_reminder refuses to cancel another user reminder', async () => {
  const id = addJob(db, { userId: other, type: 'reminder', fireAt: 5000, payload: {}, recurrence: '0 9 * * 1' });
  const res: any = await makeCancelReminderTool(db, uid).execute!({ id } as any, {} as any);
  expect(res.ok).toBe(false);
  expect(listRecurring(db, other)).toHaveLength(1); // untouched
});
