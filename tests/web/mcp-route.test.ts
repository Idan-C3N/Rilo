import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyCode } from '../../src/db/sessions.js';
import { listMcpServers } from '../../src/db/mcp.js';
import { buildWebApp } from '../../src/web/server.js';

let db: DB, uid: number, app: any, cookie: string;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(async () => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
  const { token, code } = startLogin(db, uid);
  verifyCode(db, token, code);
  cookie = `token=${token}`;
  app = await buildWebApp({ db, appCfg: {} as any });
});

describe('mcp route', () => {
  it('adds an http mcp server with parsed creds', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mcp', headers: { cookie },
      payload: { name: 'gh', transport: 'http', url: 'https://x/mcp', command: '', args: '', creds: 'Authorization=Bearer z' },
    });
    expect(res.statusCode).toBe(302);
    const list = listMcpServers(db, uid);
    expect(list[0]!.name).toBe('gh');
    expect(list[0]!.creds).toEqual({ Authorization: 'Bearer z' });
  });

  it('toggles and deletes a server', async () => {
    await app.inject({ method: 'POST', url: '/mcp', headers: { cookie }, payload: { name: 's', transport: 'stdio', command: 'node', args: 'x.js', url: '', creds: '' } });
    const id = listMcpServers(db, uid)[0]!.id;
    await app.inject({ method: 'POST', url: `/mcp/${id}/toggle`, headers: { cookie } });
    expect(listMcpServers(db, uid)[0]!.enabled).toBe(false);
    await app.inject({ method: 'POST', url: `/mcp/${id}/delete`, headers: { cookie } });
    expect(listMcpServers(db, uid)).toEqual([]);
  });
});
