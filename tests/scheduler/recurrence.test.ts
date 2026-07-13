import { describe, it, expect } from 'vitest';
import { nextFireAt, describeCron } from '../../src/scheduler/recurrence.js';

describe('nextFireAt', () => {
  it('computes the next daily occurrence at a wall-clock time in a timezone', () => {
    // 2026-01-01T00:00:00Z. Next "09:00 every day" in UTC is 2026-01-01T09:00Z.
    const after = Date.UTC(2026, 0, 1, 0, 0, 0);
    const next = nextFireAt('0 9 * * *', 'UTC', after)!;
    expect(next).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
  });

  it('resolves wall-clock time in a non-UTC timezone', () => {
    // 09:00 in Asia/Jerusalem. On 2026-01-01 the offset is +02:00, so 07:00Z.
    const after = Date.UTC(2026, 0, 1, 0, 0, 0);
    const next = nextFireAt('0 9 * * *', 'Asia/Jerusalem', after)!;
    expect(next).toBe(Date.UTC(2026, 0, 1, 7, 0, 0));
  });

  it('returns a time strictly after `after`', () => {
    const at9 = Date.UTC(2026, 0, 1, 9, 0, 0);
    const next = nextFireAt('0 9 * * *', 'UTC', at9)!;
    expect(next).toBe(Date.UTC(2026, 0, 2, 9, 0, 0)); // next day, not the same instant
  });

  it('returns null for an invalid cron expression', () => {
    expect(nextFireAt('not a cron', 'UTC', 0)).toBeNull();
  });
});

describe('describeCron', () => {
  it('falls back to the raw expression', () => {
    expect(typeof describeCron('0 9 * * 1')).toBe('string');
    expect(describeCron('0 9 * * 1').length).toBeGreaterThan(0);
  });
});
