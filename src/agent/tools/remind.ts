import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import { addJob } from '../../db/jobs.js';
import { getUserById } from '../../db/users.js';
import { nextFireAt } from '../../scheduler/recurrence.js';

export function makeRemindTool(db: DB, userId: number) {
  return tool({
    description:
      'Schedule a reminder to send back to the user. For a ONE-OFF reminder, set delay_minutes ' +
      '(convert any natural-language time, e.g. "in 2 weeks", into minutes from now). ' +
      'For a REPEATING reminder, set "recurrence" to a 5-field cron expression in the user\'s ' +
      'timezone (e.g. "0 9 * * 1" = every Monday 09:00, "30 15 * * *" = every day 15:30, ' +
      '"0 */2 * * *" = every 2 hours). Optionally cap a repeating reminder with ' +
      '"recurrence_until" (epoch ms — for "for a week" use now + 7 days) and/or ' +
      '"recurrence_count" (number of times — for "5 times" use 5). Omit both caps to repeat forever.',
    inputSchema: z.object({
      text: z.string().describe('What to remind the user about'),
      delay_minutes: z.number().int().positive().optional().describe('One-off: minutes from now to fire'),
      recurrence: z.string().optional().describe('Repeating: 5-field cron expression in the user timezone'),
      recurrence_until: z.number().int().positive().optional().describe('Repeating cap: epoch ms to stop after'),
      recurrence_count: z.number().int().positive().optional().describe('Repeating cap: number of times to fire'),
    }),
    execute: async ({ text, delay_minutes, recurrence, recurrence_until, recurrence_count }) => {
      if (recurrence) {
        const tz = getUserById(db, userId)?.tz ?? 'UTC';
        const first = nextFireAt(recurrence, tz, Date.now());
        if (first === null) {
          return { ok: false, error: 'Invalid recurrence expression.' };
        }
        addJob(db, {
          userId, type: 'reminder', fireAt: first, payload: { text },
          recurrence, recurrenceUntil: recurrence_until ?? null, recurrenceCount: recurrence_count ?? null,
        });
        return { ok: true, fire_at: first, recurring: true };
      }
      if (!delay_minutes) {
        return { ok: false, error: 'Provide either delay_minutes (one-off) or recurrence (repeating).' };
      }
      const fireAt = Date.now() + delay_minutes * 60000;
      addJob(db, { userId, type: 'reminder', fireAt, payload: { text } });
      return { ok: true, fire_at: fireAt };
    },
  });
}
