import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUserWithIdentity } from '../../../src/db/users.js';
import { buildToolsFor } from '../../../src/agent/tools/index.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('buildToolsFor', () => {
  it('merges built-in tools with mcp tools and exposes closeAll', async () => {
    let closed = false;
    const assemble = async () => ({ tools: { ext__x: { description: 'x' } as any }, closeAll: async () => { closed = true; } });
    const { tools, closeAll } = await buildToolsFor({ db, userId: uid, assemble });
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['remind', 'remember', 'recall', 'track', 'ext__x']));
    await closeAll();
    expect(closed).toBe(true);
  });
});
