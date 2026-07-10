import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import { remember, recall } from '../../db/memory.js';

export function makeRememberTool(db: DB, userId: number) {
  return tool({
    description: 'Store a durable fact about the user for future conversations.',
    inputSchema: z.object({
      text: z.string().describe('The fact to remember'),
      key: z.string().optional().describe('Optional short label'),
    }),
    execute: async ({ text, key }) => {
      remember(db, userId, text, key);
      return { ok: true };
    },
  });
}

export function makeRecallTool(db: DB, userId: number) {
  return tool({
    description: 'Recall stored facts about the user. Optionally filter by a query.',
    inputSchema: z.object({
      query: z.string().optional().describe('Substring filter; omit to list recent facts'),
    }),
    execute: async ({ query }) => ({ items: recall(db, userId, query).map((m) => m.text) }),
  });
}
