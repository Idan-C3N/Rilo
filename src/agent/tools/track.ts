import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import { remember } from '../../db/memory.js';
import { addJob } from '../../db/jobs.js';

export function makeTrackTool(db: DB, userId: number) {
  return tool({
    description:
      'Track a task the user wants to do and follow up later to check if they did it. Convert the check-in time into minutes.',
    inputSchema: z.object({
      task: z.string().describe('The task to track'),
      check_in_minutes: z.number().int().positive().describe('When to follow up, in minutes'),
    }),
    execute: async ({ task, check_in_minutes }) => {
      remember(db, userId, `tracking: ${task}`, 'tracked-task');
      addJob(db, {
        userId,
        type: 'followup',
        fireAt: Date.now() + check_in_minutes * 60000,
        payload: { task },
      });
      return { ok: true };
    },
  });
}
