import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted, getUserByIdentity } from '../../src/db/users.js';
import { setOpenrouterKey, getConfig } from '../../src/db/config.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { handleInbound, NOT_AUTHORIZED } from '../../src/agent/dispatch.js';
import { runAgentTurn } from '../../src/agent/core.js';

let db: DB;
const sent: any[] = [];
const sentOpts: any[] = [];
const typingEvents: string[] = [];
const adapter = {
  send: async (id: string, text: string, opts?: any) => { sent.push([id, text]); sentOpts.push(opts); },
  typingFor: (_id: string) => ({ start: () => typingEvents.push('start'), stop: () => typingEvents.push('stop') }),
};
const deps = () => ({
  db, appCfg: {} as any, adapter, runTurn: runAgentTurn,
  generate: async () => ({ text: 'reply!' }), heartbeatDefaultMin: 30,
  webBaseUrl: 'http://localhost:8080',
});

beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => { db = openDb(':memory:'); sent.length = 0; sentOpts.length = 0; typingEvents.length = 0; });

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

  it('handles /login by sending a magic link (no code), preview disabled, no model call', async () => {
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: '30', heartbeat_interval_min: 30 });
    setAllowlisted(db, u.id, true);
    let modelCalled = false;
    const d = { ...deps(), webBaseUrl: 'http://host:8080', generate: async () => { modelCalled = true; return { text: 'x' }; } };
    await handleInbound(d as any, { channel: 'telegram', channelUserId: '30', text: '/login', name: 'Z' });
    expect(modelCalled).toBe(false);
    expect(sent[0][1]).toMatch(/http:\/\/host:8080\/login\?token=/);
    expect(sent[0][1]).not.toContain('code'); // no 6-digit code anymore
    expect(sentOpts[0]).toMatchObject({ disableLinkPreview: true });
  });

  describe('seeding new user defaults', () => {
    it('seeds a new user\'s models from resolveDefaultModels', async () => {
      const d = {
        ...deps(),
        resolveDefaultModels: async () => ({ cheap_model: 'anthropic/x-cheap', strong_model: 'anthropic/x-strong' }),
      };
      await handleInbound(d as any, { channel: 'telegram', channelUserId: 'newuser1', text: 'hello', name: 'NewUser' });
      const uid = getUserByIdentity(db, 'telegram', 'newuser1')!.id;
      expect(getConfig(db, uid).cheap_model).toBe('anthropic/x-cheap');
      expect(getConfig(db, uid).strong_model).toBe('anthropic/x-strong');
    });

    it('keeps SQL defaults when resolveDefaultModels returns undefined', async () => {
      const d = {
        ...deps(),
        resolveDefaultModels: async () => undefined,
      };
      await handleInbound(d as any, { channel: 'telegram', channelUserId: 'newuser2', text: 'hello', name: 'NewUser' });
      const uid = getUserByIdentity(db, 'telegram', 'newuser2')!.id;
      expect(getConfig(db, uid).cheap_model).toBe('anthropic/claude-haiku-4.5');
      expect(getConfig(db, uid).strong_model).toBe('anthropic/claude-sonnet-5');
    });
  });
});
