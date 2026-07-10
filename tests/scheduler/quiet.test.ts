import { describe, it, expect } from 'vitest';
import { isQuiet } from '../../src/scheduler/quiet.js';

const u = { tz: 'UTC', quiet_start: 22, quiet_end: 8 };

describe('isQuiet', () => {
  it('true at 23:00 UTC (inside 22-8 wrap window)', () => {
    expect(isQuiet(u, Date.parse('2026-07-10T23:00:00Z'))).toBe(true);
  });
  it('true at 03:00 UTC', () => {
    expect(isQuiet(u, Date.parse('2026-07-10T03:00:00Z'))).toBe(true);
  });
  it('false at 12:00 UTC', () => {
    expect(isQuiet(u, Date.parse('2026-07-10T12:00:00Z'))).toBe(false);
  });
  it('respects timezone', () => {
    // 12:00 UTC == 15:00 Asia/Jerusalem (summer, UTC+3) → awake
    expect(isQuiet({ tz: 'Asia/Jerusalem', quiet_start: 22, quiet_end: 8 }, Date.parse('2026-07-10T12:00:00Z'))).toBe(false);
    // 02:00 UTC == 05:00 Jerusalem → quiet
    expect(isQuiet({ tz: 'Asia/Jerusalem', quiet_start: 22, quiet_end: 8 }, Date.parse('2026-07-10T02:00:00Z'))).toBe(true);
  });
});
