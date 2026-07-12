import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted, getUserByIdentity, isAllowlisted, ensureOwner } from '../../src/db/users.js';
import { setOpenrouterKey, getConfig } from '../../src/db/config.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { handleInbound, NOT_AUTHORIZED } from '../../src/agent/dispatch.js';
import { runAgentTurn } from '../../src/agent/core.js';
import {
  createRegistration,
  bindRequester,
  markPendingApproval,
  findByCode,
  findPendingByUserId,
} from '../../src/db/registrations.js';

let db: DB;
const sent: any[] = [];
const sentOpts: any[] = [];
const contactRequests: any[] = [];
const typingEvents: string[] = [];
const adapter = {
  send: async (id: string, text: string, opts?: any) => { sent.push([id, text]); sentOpts.push(opts); },
  requestContact: async (id: string, text: string) => { contactRequests.push([id, text]); },
  typingFor: (_id: string) => ({ start: () => typingEvents.push('start'), stop: () => typingEvents.push('stop') }),
};
const deps = () => ({
  db, appCfg: {} as any, adapter, runTurn: runAgentTurn,
  generate: async () => ({ text: 'reply!' }), heartbeatDefaultMin: 30,
  webBaseUrl: 'http://localhost:8080',
  ownerTelegramId: 'OWNER',
});

beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => { db = openDb(':memory:'); sent.length = 0; sentOpts.length = 0; contactRequests.length = 0; typingEvents.length = 0; });

describe('handleInbound', () => {
  it('rejects non-allowlisted users with a register hint, without calling the model', async () => {
    await handleInbound(deps(), { channel: 'telegram', channelUserId: '5', text: 'hi', name: 'X' });
    expect(sent.length).toBe(1);
    expect(sent[0][0]).toBe('5');
    expect(sent[0][1]).toContain(NOT_AUTHORIZED);
    expect(sent[0][1]).toContain('http://localhost:8080/register');
    // user auto-created but not allowlisted
    expect(getUserByIdentity(db, 'telegram', '5')?.allowlisted).toBe(0);
  });

  it('tells a pending user their request is awaiting approval', async () => {
    const reg = createRegistration(db, { name: 'Ann', phone: '972501234567' });
    const u = createUserWithIdentity(db, { channel: 'telegram', externalId: '5', heartbeat_interval_min: 30 });
    bindRequester(db, reg.id, '5', u.id);
    markPendingApproval(db, reg.id);
    await handleInbound(deps(), { channel: 'telegram', channelUserId: '5', text: 'hi', name: 'X' });
    expect(sent.length).toBe(1);
    expect(sent[0][1].toLowerCase()).toContain('awaiting approval');
  });

  describe('registration handshake', () => {
    it('/start <code> binds the requester and requests their contact', async () => {
      const reg = createRegistration(db, { name: 'Ann', phone: '972501234567' });
      await handleInbound(deps(), { channel: 'telegram', channelUserId: '5', text: `/start ${reg.code}`, name: 'Ann' });
      expect(contactRequests.length).toBe(1);
      expect(contactRequests[0][0]).toBe('5');
      const bound = findByCode(db, reg.code)!;
      expect(bound.status).toBe('awaiting_contact');
      expect(bound.channel_user_id).toBe('5');
      expect(bound.user_id).toBe(getUserByIdentity(db, 'telegram', '5')!.id);
    });

    it('rejects an unknown/expired code', async () => {
      await handleInbound(deps(), { channel: 'telegram', channelUserId: '5', text: '/start nope', name: 'Ann' });
      expect(contactRequests.length).toBe(0);
      expect(sent[0][1].toLowerCase()).toContain('expired');
    });

    it('a matching contact pings the owner and sets the request pending', async () => {
      const reg = createRegistration(db, { name: 'Ann', phone: '972501234567' });
      await handleInbound(deps(), { channel: 'telegram', channelUserId: '5', text: `/start ${reg.code}`, name: 'Ann' });
      sent.length = 0;
      await handleInbound(deps(), { channel: 'telegram', channelUserId: '5', text: '', name: 'Ann', contact: { phone: '+972-50-123-4567' } });
      const u = getUserByIdentity(db, 'telegram', '5')!;
      expect(findPendingByUserId(db, u.id)?.status).toBe('pending_approval');
      const ownerPing = sent.find((s) => s[0] === 'OWNER');
      expect(ownerPing).toBeTruthy();
      expect(ownerPing[1]).toContain(String(u.id));
      // requester gets an ack
      expect(sent.some((s) => s[0] === '5')).toBe(true);
    });

    it('a non-matching contact is rejected and pings nobody', async () => {
      const reg = createRegistration(db, { name: 'Ann', phone: '972501234567' });
      await handleInbound(deps(), { channel: 'telegram', channelUserId: '5', text: `/start ${reg.code}`, name: 'Ann' });
      sent.length = 0;
      await handleInbound(deps(), { channel: 'telegram', channelUserId: '5', text: '', name: 'Ann', contact: { phone: '+972509999999' } });
      const u = getUserByIdentity(db, 'telegram', '5')!;
      expect(findPendingByUserId(db, u.id)).toBeUndefined();
      expect(sent.some((s) => s[0] === 'OWNER')).toBe(false);
      expect(sent[0][1].toLowerCase()).toContain("doesn't match");
    });
  });

  describe('owner approval commands', () => {
    async function seedPending() {
      const reg = createRegistration(db, { name: 'Ann', phone: '972501234567' });
      const u = createUserWithIdentity(db, { channel: 'telegram', externalId: '5', heartbeat_interval_min: 30 });
      bindRequester(db, reg.id, '5', u.id);
      markPendingApproval(db, reg.id);
      return u;
    }

    it('/approve <id> by the owner allowlists the user and notifies them', async () => {
      const target = await seedPending();
      const owner = ensureOwner(db, 'OWNER');
      await handleInbound(deps(), { channel: 'telegram', channelUserId: 'OWNER', text: `/approve ${target.id}`, name: 'Owner' });
      expect(isAllowlisted(db, target.id)).toBe(true);
      expect(findPendingByUserId(db, target.id)).toBeUndefined();
      // requester (channel_user_id '5') is notified
      expect(sent.some((s) => s[0] === '5')).toBe(true);
      expect(owner.is_owner).toBe(1);
    });

    it('/approve <id> by a NON-owner does not allowlist anyone', async () => {
      const target = await seedPending();
      // a random allowlisted non-owner tries to approve
      const stranger = createUserWithIdentity(db, { channel: 'telegram', externalId: '99', heartbeat_interval_min: 30 });
      setAllowlisted(db, stranger.id, true);
      setOpenrouterKey(db, stranger.id, 'sk-or');
      await handleInbound(deps(), { channel: 'telegram', channelUserId: '99', text: `/approve ${target.id}`, name: 'S' });
      expect(isAllowlisted(db, target.id)).toBe(false);
      expect(findPendingByUserId(db, target.id)?.status).toBe('pending_approval');
    });

    it('/deny <id> by the owner marks the request denied and leaves them un-allowlisted', async () => {
      const target = await seedPending();
      ensureOwner(db, 'OWNER');
      await handleInbound(deps(), { channel: 'telegram', channelUserId: 'OWNER', text: `/deny ${target.id}`, name: 'Owner' });
      expect(isAllowlisted(db, target.id)).toBe(false);
      expect(findPendingByUserId(db, target.id)).toBeUndefined();
    });
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
