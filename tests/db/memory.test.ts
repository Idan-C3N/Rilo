import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { remember, recall, forget } from '../../src/db/memory.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('memory repo', () => {
  it('remembers and recalls all newest-first', () => {
    remember(db, uid, 'likes coffee');
    remember(db, uid, 'wife name is Dana');
    expect(recall(db, uid).map((m) => m.text)).toEqual(['wife name is Dana', 'likes coffee']);
  });

  it('recall filters by query', () => {
    remember(db, uid, 'likes coffee');
    remember(db, uid, 'allergic to peanuts');
    expect(recall(db, uid, 'coffee').map((m) => m.text)).toEqual(['likes coffee']);
  });

  it('forget removes an item', () => {
    const id = remember(db, uid, 'temp');
    forget(db, id);
    expect(recall(db, uid)).toEqual([]);
  });
});
