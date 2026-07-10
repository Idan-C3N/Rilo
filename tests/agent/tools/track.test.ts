import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUserWithIdentity } from '../../../src/db/users.js';
import { pendingJobsByType } from '../../../src/db/jobs.js';
import { recall } from '../../../src/db/memory.js';
import { makeTrackTool } from '../../../src/agent/tools/track.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('track tool', () => {
  it('records a note and schedules a followup', async () => {
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
    await (makeTrackTool(db, uid) as any).execute({ task: 'submit tax form', check_in_minutes: 60 });
    expect(recall(db, uid).some((m) => m.text.includes('submit tax form'))).toBe(true);
    const jobs = pendingJobsByType(db, uid, 'followup');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.task).toBe('submit tax form');
    expect(jobs[0]!.fire_at).toBe(Date.parse('2026-07-10T00:00:00Z') + 60 * 60000);
    vi.useRealTimers();
  });
});
