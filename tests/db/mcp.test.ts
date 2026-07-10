import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { addMcpServer, listMcpServers, listEnabledMcpServers, setMcpEnabled, deleteMcpServer } from '../../src/db/mcp.js';

let db: DB, uid: number;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(() => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
});

describe('mcp repo', () => {
  it('stores + reads http server with encrypted creds', () => {
    addMcpServer(db, uid, { name: 'gh', transport: 'http', url: 'https://x/mcp', creds: { Authorization: 'Bearer z' }, args: [] });
    const raw = db.prepare('SELECT creds_enc FROM mcp_servers').get() as any;
    expect(raw.creds_enc).not.toContain('Bearer z');
    const list = listMcpServers(db, uid);
    expect(list).toHaveLength(1);
    expect(list[0]!.creds).toEqual({ Authorization: 'Bearer z' });
    expect(list[0]!.transport).toBe('http');
  });

  it('enable/disable + listEnabled', () => {
    const id = addMcpServer(db, uid, { name: 's', transport: 'stdio', command: 'node', args: ['x.js'] });
    setMcpEnabled(db, id, false);
    expect(listEnabledMcpServers(db, uid)).toEqual([]);
    setMcpEnabled(db, id, true);
    expect(listEnabledMcpServers(db, uid)).toHaveLength(1);
  });

  it('delete', () => {
    const id = addMcpServer(db, uid, { name: 's', transport: 'stdio', command: 'node', args: [] });
    deleteMcpServer(db, id);
    expect(listMcpServers(db, uid)).toEqual([]);
  });
});
