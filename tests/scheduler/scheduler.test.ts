import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { addJob, dueJobs } from '../../src/db/jobs.js';
import { tick } from '../../src/scheduler/scheduler.js';

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
