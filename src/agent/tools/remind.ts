import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import { addJob } from '../../db/jobs.js';

export function makeRemindTool(db: DB, userId: number) {
  return tool({
    description:
      'Schedule a reminder to send back to the user after a delay. Convert any natural-language time (e.g. "in 2 weeks", "next month") into delay_minutes.',
    inputSchema: z.object({
      text: z.string().describe('What to remind the user about'),
      delay_minutes: z.number().int().positive().describe('Minutes from now to fire'),
    }),
    execute: async ({ text, delay_minutes }) => {
      const fireAt = Date.now() + delay_minutes * 60000;
      addJob(db, { userId, type: 'reminder', fireAt, payload: { text } });
      return { ok: true, fire_at: fireAt };
    },
  });
}
