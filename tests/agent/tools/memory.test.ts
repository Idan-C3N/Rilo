import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUserWithIdentity } from '../../../src/db/users.js';
import { recall } from '../../../src/db/memory.js';
import { makeRememberTool, makeRecallTool } from '../../../src/agent/tools/memory.js';

let db: DB, uid: number;
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('memory tools', () => {
  it('remember tool stores a fact', async () => {
    await (makeRememberTool(db, uid) as any).execute({ text: 'drinks tea' });
    expect(recall(db, uid).map((m) => m.text)).toContain('drinks tea');
  });
  it('recall tool returns items array', async () => {
    await (makeRememberTool(db, uid) as any).execute({ text: 'plays guitar' });
    const res = await (makeRecallTool(db, uid) as any).execute({ query: 'guitar' });
    expect(res.items).toEqual(['plays guitar']);
  });
});
