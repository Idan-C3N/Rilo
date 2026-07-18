import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { addJob, dueJobs, claimDueJobs } from '../../src/db/jobs.js';
import { tick, startScheduler, BATCH, MAX_ATTEMPTS, POLL_MS } from '../../src/scheduler/scheduler.js';

const statusOf = (db: DB, id: number) =>
  (db.prepare('SELECT status FROM jobs WHERE id=?').get(id) as { status: string }).status;

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 'tg99', heartbeat_interval_min: 30 }).id;
});

function deps(overrides: any = {}) {
  const fired: any[] = [];
  return {
    fired,
    d: {
      db, appCfg: {} as any,
      adapter: { send: async () => {} },
      generate: async () => ({ text: 'x' }),
      channel: 'telegram',
      fireReminder: async (_d: any, job: any) => { fired.push(['reminder', job.id]); },
      fireHeartbeat: async (_d: any, job: any) => { fired.push(['heartbeat', job.id]); },
      ...overrides,
    },
  };
}

describe('scheduler tick', () => {
  it('dispatches due reminder jobs and marks them done', async () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: { text: 'hi' } });
    const { fired, d } = deps();
    await tick(d as any, 100);
    expect(fired).toEqual([['reminder', id]]);
    expect(dueJobs(db, 100)).toEqual([]); // marked done
  });

  it('does not fire future jobs', async () => {
    addJob(db, { userId: uid, type: 'reminder', fireAt: 5000, payload: {} });
    const { fired, d } = deps();
    await tick(d as any, 100);
    expect(fired).toEqual([]);
  });

  it('a throwing job does not block others and is left pending', async () => {
    const bad = addJob(db, { userId: uid, type: 'reminder', fireAt: 1, payload: { text: 'bad' } });
    const good = addJob(db, { userId: uid, type: 'reminder', fireAt: 2, payload: { text: 'good' } });
    const { fired, d } = deps({
      fireReminder: async (_d: any, job: any) => {
        if (job.id === bad) throw new Error('boom');
        fired.push(job.id);
      },
    });
    await tick(d as any, 100);
    expect(fired).toEqual([good]);
    // bad still pending for retry, good is done
    expect(dueJobs(db, 100).map((j) => j.id)).toEqual([bad]);
  });
});

describe('scheduler tick — resilience', () => {
  it('claims at most BATCH jobs per tick, leaving the rest pending', async () => {
    for (let i = 0; i < BATCH + 5; i++) addJob(db, { userId: uid, type: 'reminder', fireAt: i, payload: {} });
    const { fired, d } = deps();
    await tick(d as any, 10_000);
    expect(fired).toHaveLength(BATCH);
    expect(dueJobs(db, 10_000)).toHaveLength(5); // overflow stays pending for the next tick
  });

  it('fires a due job exactly once across back-to-back ticks (no double dispatch)', async () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} });
    const { fired, d } = deps();
    await tick(d as any, 100);
    await tick(d as any, 100);
    expect(fired).toEqual([['reminder', id]]);
  });

  it('retires a persistently throwing job to failed after MAX_ATTEMPTS ticks', async () => {
    const bad = addJob(db, { userId: uid, type: 'reminder', fireAt: 1, payload: {} });
    const { d } = deps({ fireReminder: async () => { throw new Error('boom'); } });
    for (let i = 0; i < MAX_ATTEMPTS; i++) await tick(d as any, 100);
    expect(statusOf(db, bad)).toBe('failed');
    // a further tick must not re-dispatch it
    const { fired, d: d2 } = deps({ fireReminder: async () => { throw new Error('boom'); } });
    await tick(d2 as any, 100);
    expect(fired).toEqual([]);
  });

  it('reclaims an orphaned running job at startup and fires it on the first tick', async () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} });
    claimDueJobs(db, 100, 100); // simulate a crash mid-tick: job stuck 'running'
    expect(statusOf(db, id)).toBe('running');
    vi.useFakeTimers();
    try {
      const { fired, d } = deps();
      const s = startScheduler(d as any);
      await vi.advanceTimersByTimeAsync(POLL_MS + 5);
      s.stop();
      expect(fired).toEqual([['reminder', id]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() halts further ticks', async () => {
    addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} });
    vi.useFakeTimers();
    try {
      const { fired, d } = deps();
      const s = startScheduler(d as any);
      s.stop();
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(fired).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('scheduler tick — recurrence', () => {
  it('re-arms a recurring reminder in place instead of marking it done', async () => {
    // fires every minute; user tz defaults to UTC
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: { text: 'x' }, recurrence: '* * * * *' });
    const { fired, d } = deps();
    const now = Date.UTC(2026, 0, 1, 9, 0, 30); // 09:00:30
    await tick(d as any, now);
    expect(fired).toEqual([['reminder', id]]);
    // still pending, fire_at advanced to the next minute (09:01:00)
    const job = dueJobs(db, now + 3600_000).find((j) => j.id === id)!;
    expect(job.status ?? 'pending').toBe('pending');
    expect(job.fire_at).toBe(Date.UTC(2026, 0, 1, 9, 1, 0));
  });

  it('retires a recurring reminder when the count reaches 0', async () => {
    const id = addJob(db, {
      userId: uid, type: 'reminder', fireAt: 10, payload: { text: 'x' },
      recurrence: '* * * * *', recurrenceCount: 1,
    });
    const { d } = deps();
    await tick(d as any, Date.UTC(2026, 0, 1, 9, 0, 30));
    expect(dueJobs(db, Date.UTC(2027, 0, 1)).find((j) => j.id === id)).toBeUndefined(); // done
  });

  it('retires a recurring reminder once the next occurrence passes recurrence_until', async () => {
    const until = Date.UTC(2026, 0, 1, 9, 0, 45); // before the next minute boundary
    const id = addJob(db, {
      userId: uid, type: 'reminder', fireAt: 10, payload: { text: 'x' },
      recurrence: '* * * * *', recurrenceUntil: until,
    });
    const { d } = deps();
    await tick(d as any, Date.UTC(2026, 0, 1, 9, 0, 30));
    expect(dueJobs(db, Date.UTC(2027, 0, 1)).find((j) => j.id === id)).toBeUndefined(); // done
  });

  it('a downtime gap produces one fire, not one per missed occurrence', async () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: { text: 'x' }, recurrence: '* * * * *' });
    const { fired, d } = deps();
    // Box was "down"; we tick once, far past many missed minutes.
    await tick(d as any, Date.UTC(2026, 0, 1, 12, 0, 0));
    expect(fired).toEqual([['reminder', id]]); // exactly one delivery
    const job = dueJobs(db, Date.UTC(2027, 0, 1)).find((j) => j.id === id)!;
    expect(job.fire_at).toBe(Date.UTC(2026, 0, 1, 12, 1, 0)); // next occurrence from now
  });

  it('one-shot reminders still fire exactly once (regression)', async () => {
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: { text: 'x' } });
    const { fired, d } = deps();
    await tick(d as any, 100);
    expect(fired).toEqual([['reminder', id]]);
    expect(dueJobs(db, 100)).toEqual([]); // done, not re-armed
  });
});
