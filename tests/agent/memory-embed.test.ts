import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { remember, rowsMissingEmbedding } from '../../src/db/memory.js';
import { embedAndStore, semanticRecall, backfillEmbeddings } from '../../src/agent/memory-embed.js';
import type { Embedder } from '../../src/agent/embeddings.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

// Deterministic fake: maps known texts to fixed 3-vectors (ignores e5 prefix).
const vecFor = (s: string): number[] =>
  s.includes('apple') ? [1, 0, 0] : s.includes('banana') ? [0.95, 0.05, 0] : [0, 1, 0];
const fakeEmbed: Embedder = async (inputs) => inputs.map(vecFor);
const downEmbed: Embedder = async () => null;

describe('embedAndStore', () => {
  it('stores a vector; failure leaves row NULL', async () => {
    const a = remember(db, uid, 'apple');
    await embedAndStore(db, a, 'apple', fakeEmbed);
    expect(rowsMissingEmbedding(db)).toEqual([]);
    const b = remember(db, uid, 'banana');
    await embedAndStore(db, b, 'banana', downEmbed);
    expect(rowsMissingEmbedding(db).map((r) => r.text)).toEqual(['banana']);
  });
});

describe('semanticRecall', () => {
  it('ranks by vector similarity when embeddings exist', async () => {
    for (const t of ['apple', 'banana', 'carrot']) await embedAndStore(db, remember(db, uid, t), t, fakeEmbed);
    expect(await semanticRecall(db, uid, 'apple pie', fakeEmbed, 8, 0.8)).toEqual(['apple', 'banana']);
  });
  it('falls back to substring when embedder is down', async () => {
    remember(db, uid, 'likes coffee');
    remember(db, uid, 'allergic to peanuts');
    expect(await semanticRecall(db, uid, 'coffee', downEmbed)).toEqual(['likes coffee']);
  });
  it('no query -> recent list', async () => {
    remember(db, uid, 'one'); remember(db, uid, 'two');
    expect(await semanticRecall(db, uid, undefined, fakeEmbed)).toEqual(['two', 'one']);
  });
});

describe('backfillEmbeddings', () => {
  it('embeds only NULL rows and returns the count', async () => {
    remember(db, uid, 'apple'); remember(db, uid, 'carrot');
    const n = await backfillEmbeddings(db, fakeEmbed);
    expect(n).toBe(2);
    expect(rowsMissingEmbedding(db)).toEqual([]);
  });
});
