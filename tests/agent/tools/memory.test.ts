import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUserWithIdentity } from '../../../src/db/users.js';
import { recall } from '../../../src/db/memory.js';
import { makeRememberTool, makeRecallTool } from '../../../src/agent/tools/memory.js';
import type { Embedder } from '../../../src/agent/embeddings.js';
import { createSpace } from '../../../src/db/spaces.js';

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
  it('remember writes to a space the user belongs to', async () => {
    const home = createSpace(db, { name: 'Home', createdBy: uid });
    const t = makeRememberTool(db, uid);
    const res = await (t as any).execute({ text: 'kids pickup 15:30', space: 'Home' });
    expect(res).toEqual({ ok: true });
    const [row] = recall(db, uid);
    expect(row?.space_id).toBe(home.id);
  });
  it('remember rejects an unknown / non-member space', async () => {
    const t = makeRememberTool(db, uid);
    const res = await (t as any).execute({ text: 'x', space: 'Nope' });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect(recall(db, uid)).toEqual([]); // nothing written
  });
  it('remember without space stays personal', async () => {
    const t = makeRememberTool(db, uid);
    await (t as any).execute({ text: 'personal fact' });
    const [row] = recall(db, uid);
    expect(row?.space_id).toBeNull();
  });
});

describe('memory tools with embedder', () => {
  const vecFor = (s: string): number[] => (s.includes('tea') ? [1, 0] : [0, 1]);
  const fakeEmbed: Embedder = async (inputs) => inputs.map(vecFor);

  it('recall tool uses semantic ranking when embed is provided', async () => {
    await (makeRememberTool(db, uid, fakeEmbed) as any).execute({ text: 'drinks tea' });
    await (makeRememberTool(db, uid, fakeEmbed) as any).execute({ text: 'owns a bike' });
    const res = await (makeRecallTool(db, uid, fakeEmbed) as any).execute({ query: 'green tea' });
    expect(res.items).toEqual(['drinks tea']);
  });
});
