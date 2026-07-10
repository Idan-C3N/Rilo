import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { addMcpServer } from '../../src/db/mcp.js';
import { assembleMcpTools } from '../../src/mcp/manager.js';

let db: DB, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('assembleMcpTools', () => {
  it('namespaces tools by server name and closes all', async () => {
    addMcpServer(db, uid, { name: 'weather', transport: 'http', url: 'http://x', args: [] });
    let closed = 0;
    const makeClient = async () => ({
      tools: async () => ({ forecast: { description: 'f' } as any }),
      close: async () => { closed++; },
    });
    const { tools, closeAll } = await assembleMcpTools({ db, makeClient }, uid);
    expect(Object.keys(tools)).toEqual(['weather__forecast']);
    await closeAll();
    expect(closed).toBe(1);
  });

  it('skips a failing server without throwing', async () => {
    addMcpServer(db, uid, { name: 'bad', transport: 'http', url: 'http://x', args: [] });
    addMcpServer(db, uid, { name: 'good', transport: 'http', url: 'http://y', args: [] });
    const makeClient = async (s: any) => {
      if (s.name === 'bad') throw new Error('down');
      return { tools: async () => ({ ok: { description: 'o' } as any }), close: async () => {} };
    };
    const { tools } = await assembleMcpTools({ db, makeClient }, uid);
    expect(Object.keys(tools)).toEqual(['good__ok']);
  });
});
