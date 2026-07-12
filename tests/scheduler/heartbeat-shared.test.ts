import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { createSpace, addMember } from '../../src/db/spaces.js';
import { remember, recall } from '../../src/db/memory.js';

let db: DB, a: number, b: number;
beforeEach(() => {
  db = openDb(':memory:');
  a = createUserWithIdentity(db, { channel: 'telegram', externalId: 'a', heartbeat_interval_min: 30 }).id;
  b = createUserWithIdentity(db, { channel: 'telegram', externalId: 'b', heartbeat_interval_min: 30 }).id;
});

describe('heartbeat facts include shared space', () => {
  it('a member sees a co-member\'s shared fact in the recalled facts string', () => {
    const home = createSpace(db, { name: 'Home', createdBy: a });
    addMember(db, home.id, b);
    remember(db, a, 'anniversary Feb 14', undefined, home.id);
    const facts = recall(db, b).map((m) => m.text).join('\n');
    expect(facts).toContain('anniversary Feb 14');
  });
});
