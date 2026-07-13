import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUserWithIdentity } from '../../../src/db/users.js';
import { pendingJobsByType, listRecurring } from '../../../src/db/jobs.js';
import { nextFireAt } from '../../../src/scheduler/recurrence.js';
import { makeRemindTool } from '../../../src/agent/tools/remind.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('remind tool', () => {
  it('schedules a reminder job at now + delay', async () => {
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
    const tool = makeRemindTool(db, uid) as any;
    const res = await tool.execute({ text: 'call mom', delay_minutes: 10 });
    expect(res.ok).toBe(true);
    const jobs = pendingJobsByType(db, uid, 'reminder');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.text).toBe('call mom');
    expect(jobs[0]!.fire_at).toBe(Date.parse('2026-07-10T00:00:00Z') + 10 * 60000);
    vi.useRealTimers();
  });
});

describe('remind tool — recurrence', () => {
  it('stores a recurring reminder with the first fire at the first occurrence', async () => {
    const tool = makeRemindTool(db, uid);
    await tool.execute!(
      { text: 'standup', recurrence: '0 9 * * 1' } as any,
      {} as any,
    );
    const list = listRecurring(db, uid);
    expect(list).toHaveLength(1);
    expect(list[0]!.recurrence).toBe('0 9 * * 1');
    // fire_at is a valid future occurrence, not now+delay
    expect(list[0]!.fire_at).toBe(nextFireAt('0 9 * * 1', 'UTC', list[0]!.fire_at - 1));
  });

  it('stores caps (until + count)', async () => {
    const tool = makeRemindTool(db, uid);
    await tool.execute!(
      { text: 'daily', recurrence: '0 9 * * *', recurrence_count: 7 } as any,
      {} as any,
    );
    expect(listRecurring(db, uid)[0]!.recurrence_count).toBe(7);
  });

  it('rejects an invalid cron expression without storing a job', async () => {
    const tool = makeRemindTool(db, uid);
    const res: any = await tool.execute!({ text: 'x', recurrence: 'nope' } as any, {} as any);
    expect(res.ok).toBe(false);
    expect(listRecurring(db, uid)).toHaveLength(0);
  });

  it('one-shot delay_minutes path is unchanged', async () => {
    const tool = makeRemindTool(db, uid);
    const res: any = await tool.execute!({ text: 'soon', delay_minutes: 5 } as any, {} as any);
    expect(res.ok).toBe(true);
    expect(listRecurring(db, uid)).toHaveLength(0); // not recurring
  });
});
