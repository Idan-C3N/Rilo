import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import { listRecurring, cancelJob } from '../../db/jobs.js';
import { describeCron } from '../../scheduler/recurrence.js';

export function makeListRemindersTool(db: DB, userId: number) {
  return tool({
    description: 'List the user\'s active repeating reminders (id, schedule, next fire time, remaining count).',
    inputSchema: z.object({}),
    execute: async () => ({
      reminders: listRecurring(db, userId).map((j) => ({
        id: j.id,
        schedule: describeCron(j.recurrence!),
        next_fire: j.fire_at,
        text: String(j.payload.text ?? ''),
        remaining: j.recurrence_count,
      })),
    }),
  });
}

export function makeCancelReminderTool(db: DB, userId: number) {
  return tool({
    description: 'Cancel one of the user\'s repeating reminders by its id (from list_reminders).',
    inputSchema: z.object({ id: z.number().int().describe('The reminder id to cancel') }),
    execute: async ({ id }) => {
      // Ownership gate: only cancel an id that belongs to this user's active recurring reminders.
      const owned = listRecurring(db, userId).some((j) => j.id === id);
      if (!owned) return { ok: false, error: 'No such reminder for you.' };
      cancelJob(db, id);
      return { ok: true, cancelled: id };
    },
  });
}
