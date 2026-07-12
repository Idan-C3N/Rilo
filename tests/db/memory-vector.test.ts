import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import {
  remember, setEmbedding, recallVector, rowsMissingEmbedding,
  vecToBlob, blobToVec, cosine,
} from '../../src/db/memory.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('vector helpers', () => {
  it('blob round-trips a Float32Array', () => {
    const v = Float32Array.from([0.5, -0.25, 1]);
    expect(Array.from(blobToVec(vecToBlob(v)))).toEqual(Array.from(v));
  });
  it('cosine: identical=1, orthogonal=0', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0);
  });
});

describe('recallVector', () => {
  it('ranks by cosine and applies k + threshold', () => {
    const a = remember(db, uid, 'apple');   setEmbedding(db, a, Float32Array.from([1, 0, 0]));
    const b = remember(db, uid, 'banana');  setEmbedding(db, b, Float32Array.from([0.9, 0.1, 0]));
    const c = remember(db, uid, 'carrot');  setEmbedding(db, c, Float32Array.from([0, 1, 0]));
    void c;
    const hits = recallVector(db, uid, Float32Array.from([1, 0, 0]), 8, 0.8);
    expect(hits.map((m) => m.text)).toEqual(['apple', 'banana']); // carrot below 0.8
  });
  it('skips rows with no embedding', () => {
    remember(db, uid, 'no-vec');
    expect(recallVector(db, uid, Float32Array.from([1, 0, 0]))).toEqual([]);
  });
});

describe('rowsMissingEmbedding', () => {
  it('returns only rows with NULL embedding', () => {
    const a = remember(db, uid, 'has');   setEmbedding(db, a, Float32Array.from([1, 0]));
    remember(db, uid, 'missing');
    expect(rowsMissingEmbedding(db).map((r) => r.text)).toEqual(['missing']);
  });
});
