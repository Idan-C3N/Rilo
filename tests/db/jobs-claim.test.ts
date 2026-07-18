import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import {
  addJob, dueJobs, claimDueJobs, reclaimOrphans, failJob, rearmJob,
} from '../../src/db/jobs.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 'c', heartbeat_interval_min: 30 }).id;
});

// helper: raw status of a job id
const statusOf = (id: number) =>
  (db.prepare('SELECT status FROM jobs WHERE id=?').get(id) as { status: string }).status;

describe('claimDueJobs', () => {
  it('claims due pending jobs oldest-first, marks them running, and returns them', () => {
    const a = addJob(db, { userId: uid, type: 'reminder', fireAt: 100, payload: { t: 'a' } });
    const b = addJob(db, { userId: uid, type: 'reminder', fireAt: 50, payload: { t: 'b' } });
    addJob(db, { userId: uid, type: 'reminder', fireAt: 999, payload: { t: 'future' } });
    const claimed = claimDueJobs(db, 200, 100);
    expect(claimed.map((j) => j.id)).toEqual([b, a]); // fire_at ASC
    expect(claimed.every((j) => j.status === 'running')).toBe(true);
    expect(statusOf(a)).toBe('running');
    expect(statusOf(b)).toBe('running');
  });

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) addJob(db, { userId: uid, type: 'reminder', fireAt: i, payload: {} });
    const claimed = claimDueJobs(db, 1000, 2);
    expect(claimed).toHaveLength(2);
    // 3 remain pending
    expect(db.prepare("SELECT COUNT(*) c FROM jobs WHERE status='pending'").get()).toEqual({ c: 3 });
  });

  it('does not claim future jobs', () => {
    addJob(db, { userId: uid, type: 'reminder', fireAt: 5000, payload: {} });
    expect(claimDueJobs(db, 100, 100)).toEqual([]);
  });

  it('does not re-claim an already-running job (atomic; no double dispatch)', () => {
    addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} });
    const first = claimDueJobs(db, 100, 100);
    expect(first).toHaveLength(1);
    const second = claimDueJobs(db, 100, 100); // overlapping tick sees nothing pending
    expect(second).toEqual([]);
  });
});

describe('reclaimOrphans', () => {
  it('flips running jobs back to pending and returns the count', () => {
    addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} });
    addJob(db, { userId: uid, type: 'reminder', fireAt: 20, payload: {} });
    claimDueJobs(db, 100, 100); // both now running
    const n = reclaimOrphans(db);
    expect(n).toBe(2);
    expect(db.prepare("SELECT COUNT(*) c FROM jobs WHERE status='pending'").get()).toEqual({ c: 2 });
  });

  it('leaves done/pending/cancelled jobs untouched', () => {
    addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} });
    expect(reclaimOrphans(db)).toBe(0);
  });
});

describe('failJob', () => {
  it('first failure increments attempts and re-arms to pending for retry', () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} });
    claimDueJobs(db, 100, 100); // running
    expect(failJob(db, id, 5)).toBe('retry');
    expect(statusOf(id)).toBe('pending');
    expect(dueJobs(db, 100).find((j) => j.id === id)!.attempts).toBe(1);
  });

  it('retires to failed once attempts reach maxAttempts', () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} });
    let result: string = 'retry';
    for (let i = 0; i < 5; i++) {
      claimDueJobs(db, 100, 100); // re-claim between attempts
      result = failJob(db, id, 5);
    }
    expect(result).toBe('failed');
    expect(statusOf(id)).toBe('failed');
    expect(dueJobs(db, 100).find((j) => j.id === id)).toBeUndefined(); // not pending
  });
});

describe('rearmJob resets claim state', () => {
  it('sets a claimed (running) recurring job back to pending with attempts=0', () => {
    const id = addJob(db, {
      userId: uid, type: 'reminder', fireAt: 10, payload: {}, recurrence: '* * * * *',
    });
    claimDueJobs(db, 100, 100); // running
    failJob(db, id, 5); // attempts=1, pending
    claimDueJobs(db, 100, 100); // running again
    rearmJob(db, id, 5000, null);
    const job = dueJobs(db, 6000).find((j) => j.id === id)!;
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.fire_at).toBe(5000);
  });
});
