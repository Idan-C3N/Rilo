import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { addMessage, recentMessages, messagesSince } from '../../src/db/messages.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('messages repo', () => {
  it('stores and returns recent messages in order, capped', () => {
    for (let i = 0; i < 5; i++) addMessage(db, uid, 'user', `m${i}`);
    const recent = recentMessages(db, uid, 3);
    expect(recent.map((m) => m.content)).toEqual(['m2', 'm3', 'm4']);
  });

  it('messagesSince returns only newer rows', () => {
    const id1 = addMessage(db, uid, 'user', 'a');
    addMessage(db, uid, 'assistant', 'b');
    expect(messagesSince(db, uid, id1).map((m) => m.content)).toEqual(['b']);
  });
});
