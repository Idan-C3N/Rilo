import type { DB } from '../db/db.js';
import type { Embedder } from './embeddings.js';
import { embedQuery, embedPassages } from './embeddings.js';
import { recall, setEmbedding, recallVector, rowsMissingEmbedding } from '../db/memory.js';

/** Best-effort: embed one memory's text and persist the vector. Never throws. */
export async function embedAndStore(db: DB, id: number, text: string, embed: Embedder): Promise<void> {
  const [vec] = await embedPassages(embed, [text]);
  if (vec) setEmbedding(db, id, vec);
}

/**
 * Semantic recall with graceful fallback. Returns memory texts.
 * - no query            -> recent list
 * - server down/no hits -> substring LIKE (today's behavior)
 */
export async function semanticRecall(
  db: DB, userId: number, query: string | undefined, embed: Embedder, k = 8, threshold = 0.8,
): Promise<string[]> {
  if (!query) return recall(db, userId).map((m) => m.text);
  const vec = await embedQuery(embed, query);
  if (vec) {
    const hits = recallVector(db, userId, vec, k, threshold);
    if (hits.length) return hits.map((m) => m.text);
  }
  return recall(db, userId, query).map((m) => m.text);
}

/** Embed rows that have no vector yet (boot backfill). Returns how many filled. */
export async function backfillEmbeddings(db: DB, embed: Embedder, limit = 100): Promise<number> {
  const rows = rowsMissingEmbedding(db, limit);
  let filled = 0;
  for (const r of rows) {
    const [vec] = await embedPassages(embed, [r.text]);
    if (vec) { setEmbedding(db, r.id, vec); filled++; }
  }
  return filled;
}
