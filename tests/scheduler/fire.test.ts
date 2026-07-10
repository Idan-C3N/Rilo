import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity, setAllowlisted } from '../../src/db/users.js';
import { setOpenrouterKey } from '../../src/db/config.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { recentMessages } from '../../src/db/messages.js';
import { fireReminder } from '../../src/scheduler/fire.js';

let db: DB, uid: number;
const sent: any[] = [];
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 'chat55', heartbeat_interval_min: 30 }).id;
  setAllowlisted(db, uid, true);
  setOpenrouterKey(db, uid, 'sk-or');
  sent.length = 0;
});

describe('fireReminder', () => {
  it('phrases via cheap model and sends to the user chat', async () => {
    const deps: any = {
      db, appCfg: {}, channel: 'telegram',
      adapter: { send: async (id: string, text: string) => { sent.push([id, text]); } },
      generate: async (args: any) => {
        expect(JSON.stringify(args.messages)).toContain('buy milk');
        return { text: 'Reminder: buy milk 🥛' };
      },
    };
    await fireReminder(deps, { id: 1, user_id: uid, type: 'reminder', fire_at: 0, payload: { text: 'buy milk' }, status: 'pending' });
    expect(sent).toEqual([['chat55', 'Reminder: buy milk 🥛']]);
    expect(recentMessages(db, uid, 5).at(-1)?.content).toBe('Reminder: buy milk 🥛');
  });

  it('phrases followup check-in distinctly with task payload', async () => {
    const deps: any = {
      db, appCfg: {}, channel: 'telegram',
      adapter: { send: async (id: string, text: string) => { sent.push([id, text]); } },
      generate: async (args: any) => {
        expect(JSON.stringify(args.messages)).toContain('submit tax form');
        return { text: 'Did you get a chance to submit that tax form?' };
      },
    };
    await fireReminder(deps, { id: 2, user_id: uid, type: 'followup', fire_at: 0, payload: { task: 'submit tax form' }, status: 'pending' });
    expect(sent).toEqual([['chat55', 'Did you get a chance to submit that tax form?']]);
    expect(recentMessages(db, uid, 5).at(-1)?.content).toBe('Did you get a chance to submit that tax form?');
  });

  it('does nothing for a non-allowlisted user', async () => {
    setAllowlisted(db, uid, false);
    const deps: any = {
      db, appCfg: {}, channel: 'telegram',
      adapter: { send: async (id: string, text: string) => { sent.push([id, text]); } },
      generate: async () => { throw new Error('should not be called'); },
    };
    await fireReminder(deps, { id: 3, user_id: uid, type: 'reminder', fire_at: 0, payload: { text: 'buy milk' }, status: 'pending' });
    expect(sent).toEqual([]);
  });
});
