import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { addJob, dueJobs, markDone, cancelJob, pendingJobsByType } from '../../src/db/jobs.js';

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
