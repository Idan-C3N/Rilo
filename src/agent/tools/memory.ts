import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import { remember, recall } from '../../db/memory.js';
import type { Embedder } from '../embeddings.js';
import { embedAndStore, semanticRecall } from '../memory-embed.js';

export function makeRememberTool(db: DB, userId: number, embed?: Embedder) {
  return tool({
    description: 'Store a durable fact about the user for future conversations.',
    inputSchema: z.object({
      text: z.string().describe('The fact to remember'),
      key: z.string().optional().describe('Optional short label'),
    }),
    execute: async ({ text, key }) => {
      const id = remember(db, userId, text, key);
      if (embed) await embedAndStore(db, id, text, embed);
      return { ok: true };
    },
  });
}

export function makeRecallTool(db: DB, userId: number, embed?: Embedder) {
  return tool({
    description: 'Recall stored facts about the user. Optionally filter by a query.',
    inputSchema: z.object({
      query: z.string().optional().describe('What to recall; omit to list recent facts'),
    }),
    execute: async ({ query }) => ({
      items: embed
        ? await semanticRecall(db, userId, query, embed)
        : recall(db, userId, query).map((m) => m.text),
    }),
  });
}
