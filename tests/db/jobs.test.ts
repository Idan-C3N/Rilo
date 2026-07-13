import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { addJob, dueJobs, markDone, cancelJob, pendingJobsByType, rearmJob, listRecurring } from '../../src/db/jobs.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('jobs repo', () => {
  it('returns only due, pending jobs oldest-first', () => {
    addJob(db, { userId: uid, type: 'reminder', fireAt: 100, payload: { text: 'a' } });
    addJob(db, { userId: uid, type: 'reminder', fireAt: 50, payload: { text: 'b' } });
    addJob(db, { userId: uid, type: 'reminder', fireAt: 999, payload: { text: 'future' } });
    const due = dueJobs(db, 200);
    expect(due.map((j) => j.payload.text)).toEqual(['b', 'a']);
  });

  it('markDone removes from due set', () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} });
    markDone(db, id);
    expect(dueJobs(db, 100)).toEqual([]);
  });

  it('cancelJob removes from due set and pendingJobsByType', () => {
    const id = addJob(db, { userId: uid, type: 'followup', fireAt: 10, payload: {} });
    cancelJob(db, id);
    expect(pendingJobsByType(db, uid, 'followup')).toEqual([]);
  });
});

describe('recurring jobs', () => {
  it('addJob stores recurrence fields and hydrates them', () => {
    const id = addJob(db, {
      userId: uid, type: 'reminder', fireAt: 100, payload: { text: 'r' },
      recurrence: '0 9 * * 1', recurrenceUntil: 9999, recurrenceCount: 5,
    });
    const job = dueJobs(db, 200).find((j) => j.id === id)!;
    expect(job.recurrence).toBe('0 9 * * 1');
    expect(job.recurrence_until).toBe(9999);
    expect(job.recurrence_count).toBe(5);
  });

  it('one-shot jobs have null recurrence fields', () => {
    addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} });
    const job = dueJobs(db, 100)[0]!;
    expect(job.recurrence).toBeNull();
    expect(job.recurrence_until).toBeNull();
    expect(job.recurrence_count).toBeNull();
  });

  it('rearmJob updates fire_at + count and keeps the job pending', () => {
    const id = addJob(db, {
      userId: uid, type: 'reminder', fireAt: 10, payload: {}, recurrence: '* * * * *', recurrenceCount: 3,
    });
    rearmJob(db, id, 5000, 2);
    expect(dueJobs(db, 100)).toEqual([]);          // no longer due (fire_at moved to 5000)
    const job = dueJobs(db, 6000).find((j) => j.id === id)!;
    expect(job.fire_at).toBe(5000);
    expect(job.recurrence_count).toBe(2);
  });

  it('rearmJob accepts null count (uncapped)', () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {}, recurrence: '* * * * *' });
    rearmJob(db, id, 5000, null);
    const job = dueJobs(db, 6000).find((j) => j.id === id)!;
    expect(job.recurrence_count).toBeNull();
  });

  it('listRecurring returns only pending recurring jobs for the user', () => {
    const rec = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {}, recurrence: '0 9 * * 1' });
    addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} }); // one-shot, excluded
    const cancelled = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {}, recurrence: '0 9 * * 1' });
    cancelJob(db, cancelled);
    const list = listRecurring(db, uid);
    expect(list.map((j) => j.id)).toEqual([rec]);
  });
});
