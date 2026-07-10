import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted, getUserByIdentity } from '../../src/db/users.js';
import { setOpenrouterKey } from '../../src/db/config.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { handleInbound, NOT_AUTHORIZED } from '../../src/agent/dispatch.js';
import { runAgentTurn } from '../../src/agent/core.js';

let db: DB;
const sent: any[] = [];
const typingEvents: string[] = [];
const adapter = {
  send: async (id: string, text: string) => { sent.push([id, text]); },
  typingFor: (_id: string) => ({ start: () => typingEvents.push('start'), stop: () => typingEvents.push('stop') }),
};
const deps = () => ({
  db, appCfg: {} as any, adapter, runTurn: runAgentTurn,
  generate: async () => ({ text: 'reply!' }), heartbeatDefaultMin: 30,
});

beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => { db = openDb(':memory:'); sent.length = 0; typingEvents.length = 0; });

describe('handleInbound', () => {
  it('rejects non-allowlisted users without calling the model', async () => {
    await handleInbound(deps(), { channel: 'telegram', channelUserId: '5', text: 'hi', name: 'X' });
    expect(sent).toEqual([['5', NOT_AUTHORIZED]]);
    // user auto-created but not allowlisted
    expect(getUserByIdentity(db, 'telegram', '5')?.allowlisted).toBe(0);
  });

  it('runs a turn for an allowlisted user with typing lifecycle', async () => {
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: '9', heartbeat_interval_min: 30 });
    setAllowlisted(db, u.id, true);
    setOpenrouterKey(db, u.id, 'sk-or');
    await handleInbound(deps(), { channel: 'telegram', channelUserId: '9', text: 'hi', name: 'Y' });
    expect(sent).toEqual([['9', 'reply!']]);
    expect(typingEvents).toEqual(['start', 'stop']);
  });

  it('invokes maybeSummarize after a successful reply', async () => {
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: '11', heartbeat_interval_min: 30 });
    setAllowlisted(db, u.id, true);
    setOpenrouterKey(db, u.id, 'sk-or');
    let calledWith: number | undefined;
    const d = { ...deps(), maybeSummarize: async (_deps: any, userId: number) => { calledWith = userId; } };
    await handleInbound(d, { channel: 'telegram', channelUserId: '11', text: 'hi', name: 'Z' });
    expect(calledWith).toBe(u.id);
  });

  it('does not break the reply if maybeSummarize throws', async () => {
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: '12', heartbeat_interval_min: 30 });
    setAllowlisted(db, u.id, true);
    setOpenrouterKey(db, u.id, 'sk-or');
    const d = { ...deps(), maybeSummarize: async () => { throw new Error('boom'); } };
    await handleInbound(d, { channel: 'telegram', channelUserId: '12', text: 'hi', name: 'Z' });
    expect(sent).toEqual([['12', 'reply!']]);
  });
});
