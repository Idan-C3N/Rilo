import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted } from '../../src/db/users.js';
import { setOpenrouterKey } from '../../src/db/config.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { pendingHeartbeat } from '../../src/db/jobs.js';
import { recentMessages } from '../../src/db/messages.js';
import { fireHeartbeat, seedHeartbeats } from '../../src/scheduler/heartbeat.js';

let db: DB, uid: number;
const sent: any[] = [];
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  const u = createUserWithIdentity(db, { channel: 'telegram', externalId: 'hb1', heartbeat_interval_min: 30 });
  uid = u.id;
  setAllowlisted(db, uid, true);
  setOpenrouterKey(db, uid, 'sk-or');
  sent.length = 0;
  // ensure not quiet: force tz where it's daytime
  db.prepare('UPDATE users SET tz=?, quiet_start=?, quiet_end=? WHERE id=?').run('UTC', 0, 0, uid);
});

function deps(decision: any) {
  return {
    db, appCfg: {} as any, channel: 'telegram',
    adapter: { send: async (id: string, t: string) => { sent.push([id, t]); } },
    generate: async () => ({ text: '' }),
    decideHeartbeat: async () => decision,
  } as any;
}

const job = () => ({ id: 1, user_id: uid, type: 'heartbeat' as const, fire_at: 0, payload: {}, status: 'pending' as const });

describe('heartbeat', () => {
  it('reschedules the next heartbeat every fire', async () => {
    await fireHeartbeat(deps({ act: false }), job());
    expect(pendingHeartbeat(db, uid)).toBeDefined();
  });

  it('stays silent when gate says no', async () => {
    await fireHeartbeat(deps({ act: false }), job());
    expect(sent).toEqual([]);
  });

  it('messages the user when gate says act', async () => {
    await fireHeartbeat(deps({ act: true, message: 'Did you call the dentist?' }), job());
    expect(sent).toEqual([['hb1', 'Did you call the dentist?']]);
    expect(recentMessages(db, uid, 5).at(-1)?.content).toBe('Did you call the dentist?');
  });

  it('stays silent during quiet hours even if gate would act', async () => {
    db.prepare('UPDATE users SET quiet_start=0, quiet_end=24 WHERE id=?').run(uid); // always quiet
    await fireHeartbeat(deps({ act: true, message: 'ping' }), job());
    expect(sent).toEqual([]);
  });

  it('seedHeartbeats schedules one per allowlisted user without a pending heartbeat', () => {
    seedHeartbeats(db, {} as any);
    expect(pendingHeartbeat(db, uid)).toBeDefined();
    seedHeartbeats(db, {} as any); // idempotent
    expect(db.prepare("SELECT COUNT(*) c FROM jobs WHERE type='heartbeat' AND status='pending'").get()).toEqual({ c: 1 });
  });

  it('never throws and still reschedules when decideHeartbeat fails transiently', async () => {
    const depsThrowing = {
      db, appCfg: {} as any, channel: 'telegram',
      adapter: { send: async (id: string, t: string) => { sent.push([id, t]); } },
      generate: async () => ({ text: '' }),
      decideHeartbeat: async () => { throw new Error('network blip'); },
    } as any;
    await expect(fireHeartbeat(depsThrowing, job())).resolves.toBeUndefined();
    expect(pendingHeartbeat(db, uid)).toBeDefined();
    expect(sent).toEqual([]);
  });

  it('reschedules even when the user has no linked identity for the channel', async () => {
    const depsNoIdentity = {
      db, appCfg: {} as any, channel: 'whatsapp', // no identity for whatsapp
      adapter: { send: async (id: string, t: string) => { sent.push([id, t]); } },
      generate: async () => ({ text: '' }),
      decideHeartbeat: async () => ({ act: true, message: 'should not send' }),
    } as any;
    await fireHeartbeat(depsNoIdentity, job());
    expect(pendingHeartbeat(db, uid)).toBeDefined();
    expect(sent).toEqual([]);
  });
});
