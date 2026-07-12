import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import { remember, recall } from '../../db/memory.js';
import { getSpaceByName } from '../../db/spaces.js';
import type { Embedder } from '../embeddings.js';
import { embedAndStore, semanticRecall } from '../memory-embed.js';

export function makeRememberTool(db: DB, userId: number, embed?: Embedder) {
  return tool({
    description:
      'Store a durable fact for future conversations. By default the fact is PRIVATE to this user. ' +
      'Only set "space" when the user asks to share a fact with a space they belong to, OR after you ' +
      'proposed sharing and the user confirmed. When a statement is clearly relevant to a shared space ' +
      '(e.g. a household), ask "Save to <space>?" before setting "space" — do not share silently.',
    inputSchema: z.object({
      text: z.string().describe('The fact to remember'),
      key: z.string().optional().describe('Optional short label'),
      space: z.string().optional().describe('Name of a space to share this fact with; omit to keep it private'),
    }),
    execute: async ({ text, key, space }) => {
      let spaceId: number | undefined;
      if (space) {
        const s = getSpaceByName(db, userId, space);
        if (!s) return { ok: false, error: `No space named "${space}" that you belong to.` };
        spaceId = s.id;
      }
      const id = remember(db, userId, text, key, spaceId);
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
