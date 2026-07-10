import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { setOpenrouterKey } from '../../src/db/config.js';
import { recentMessages } from '../../src/db/messages.js';
import { runAgentTurn } from '../../src/agent/core.js';

let db: DB, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
  setOpenrouterKey(db, uid, 'sk-or-test');
});

describe('runAgentTurn', () => {
  it('persists user + assistant messages and returns reply', async () => {
    const generate = async (args: any) => {
      // last message is the user's input
      expect(args.messages.at(-1).content).toBe('hello');
      return { text: 'hi there' };
    };
    const reply = await runAgentTurn(
      { db, appCfg: {} as any, generate },
      { userId: uid, input: 'hello' },
    );
    expect(reply).toBe('hi there');
    const hist = recentMessages(db, uid, 10);
    expect(hist.map((m) => `${m.role}:${m.content}`)).toEqual(['user:hello', 'assistant:hi there']);
  });

  it('passes prior history into the model', async () => {
    await runAgentTurn({ db, appCfg: {} as any, generate: async () => ({ text: 'a1' }) }, { userId: uid, input: 'q1' });
    let seen: any[] = [];
    const generate = async (args: any) => { seen = args.messages; return { text: 'a2' }; };
    await runAgentTurn({ db, appCfg: {} as any, generate }, { userId: uid, input: 'q2' });
    expect(seen.map((m) => m.content)).toEqual(['q1', 'a1', 'q2']);
  });
});
