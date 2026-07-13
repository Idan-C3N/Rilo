import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { createSpace, addMember } from '../../src/db/spaces.js';
import { remember, recall, recallVector, setEmbedding } from '../../src/db/memory.js';

let db: DB, a: number, b: number, c: number, homeId: number;
beforeEach(() => {
  db = openDb(':memory:');
  a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 }).id;
  b = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', heartbeat_interval_min: 30 }).id;
  c = createUserWithIdentity(db, { channel: 'telegram', externalId: 'c', heartbeat_interval_min: 30 }).id;
  homeId = createSpace(db, { name: 'Home', createdBy: a }).id;
  addMember(db, homeId, b);
});

describe('scope-aware recall', () => {
  it('personal facts never leak to another user', () => {
    remember(db, a, 'a-secret');
    expect(recall(db, b).map((m) => m.text)).toEqual([]);
  });

  it('shared facts are visible to every member, not to non-members', () => {
    remember(db, a, 'kids pickup 15:30', undefined, homeId);
    expect(recall(db, b).map((m) => m.text)).toEqual(['kids pickup 15:30']); // b is a member
    expect(recall(db, c).map((m) => m.text)).toEqual([]);                    // c is not
  });

  it('recall merges personal + shared for the caller', () => {
    remember(db, a, 'a-personal');
    remember(db, a, 'shared-fact', undefined, homeId);
    expect(recall(db, a).map((m) => m.text).sort()).toEqual(['a-personal', 'shared-fact']);
  });

  it('MemoryItem carries space_id', () => {
    remember(db, a, 'shared', undefined, homeId);
    const [row] = recall(db, a);
    expect(row?.space_id).toBe(homeId);
  });

  it('recallVector merges shared rows into the ranked set', () => {
    const s = remember(db, a, 'shared-vec', undefined, homeId);
    setEmbedding(db, s, Float32Array.from([1, 0, 0]));
    const hits = recallVector(db, b, Float32Array.from([1, 0, 0]), 8, 0.8);
    expect(hits.map((m) => m.text)).toEqual(['shared-vec']); // b sees a's shared row
  });
});
