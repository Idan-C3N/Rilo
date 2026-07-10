import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUserWithIdentity } from '../../../src/db/users.js';
import { pendingJobsByType } from '../../../src/db/jobs.js';
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
