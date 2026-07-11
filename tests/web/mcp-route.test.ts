import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyCode } from '../../src/db/sessions.js';
import { listMcpServers, addMcpServer } from '../../src/db/mcp.js';
import { hasOAuthToken } from '../../src/db/oauth.js';
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

describe('mcp preset catalog', () => {
  it('one-click adds the Slack preset with baked-in transport/command + pasted secrets', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mcp/preset', headers: { cookie },
      payload: { preset_id: 'slack', SLACK_BOT_TOKEN: 'xoxb-abc', SLACK_TEAM_ID: 'T123' },
    });
    expect(res.statusCode).toBe(302);
    const s = listMcpServers(db, uid)[0]!;
    expect(s.name).toBe('Slack');
    expect(s.transport).toBe('stdio');
    expect(s.command).toBe('npx');
    expect(s.args).toContain('@modelcontextprotocol/server-slack');
    expect(s.creds).toEqual({ SLACK_BOT_TOKEN: 'xoxb-abc', SLACK_TEAM_ID: 'T123' });
  });

  it('custom-http preset maps __url to the server url and Authorization to creds', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mcp/preset', headers: { cookie },
      payload: { preset_id: 'custom-http', __url: 'https://my/mcp', Authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(302);
    const s = listMcpServers(db, uid)[0]!;
    expect(s.transport).toBe('http');
    expect(s.url).toBe('https://my/mcp');
    expect(s.creds).toEqual({ Authorization: 'Bearer tok' });
  });

  it('unknown preset id is a no-op redirect', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mcp/preset', headers: { cookie },
      payload: { preset_id: 'nope' },
    });
    expect(res.statusCode).toBe(302);
    expect(listMcpServers(db, uid)).toEqual([]);
  });

  it('GET /mcp renders Services page: built-in web search + connect catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/mcp', headers: { cookie } });
    expect(res.body).toContain('Built in');
    expect(res.body).toContain('Web Search');
    expect(res.body).toContain('Connect a service');
    expect(res.body).toContain('Slack');
  });
});

describe('google connect flow', () => {
  it('shows connect card + stores/removes the refresh token when google is enabled', async () => {
    const gApp = await buildWebApp({ db, appCfg: { googleClientId: 'c', googleClientSecret: 's' } as any });
    // not connected → connect form visible
    let res = await gApp.inject({ method: 'GET', url: '/mcp', headers: { cookie } });
    expect(res.body).toContain('Google Workspace');
    expect(res.body).toContain('Connect Google');
    // connect
    res = await gApp.inject({ method: 'POST', url: '/google/connect', headers: { cookie }, payload: { refresh_token: '1//refresh' } });
    expect(res.statusCode).toBe(302);
    expect(hasOAuthToken(db, uid, 'google')).toBe(true);
    // now shows connected
    res = await gApp.inject({ method: 'GET', url: '/mcp', headers: { cookie } });
    expect(res.body).toContain('connected');
    // disconnect
    res = await gApp.inject({ method: 'POST', url: '/google/disconnect', headers: { cookie } });
    expect(hasOAuthToken(db, uid, 'google')).toBe(false);
  });

  it('hides the google card when google is not enabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/mcp', headers: { cookie } });
    expect(res.body).not.toContain('Google Workspace');
  });
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

  it('prevents cross-user toggle and delete', async () => {
    // Create user B and add server owned by B
    const userB = createUserWithIdentity(db, { channel: 'telegram', externalId: 'tb', heartbeat_interval_min: 30 });
    addMcpServer(db, userB.id, { name: 'server-b', transport: 'stdio', command: 'node', args: ['x.js'], url: undefined, creds: undefined });
    const serverId = listMcpServers(db, userB.id)[0]!.id;

    // As user A, try to toggle user B's server
    await app.inject({ method: 'POST', url: `/mcp/${serverId}/toggle`, headers: { cookie } });
    expect(listMcpServers(db, userB.id)[0]!.enabled).toBe(true);

    // As user A, try to delete user B's server
    await app.inject({ method: 'POST', url: `/mcp/${serverId}/delete`, headers: { cookie } });
    expect(listMcpServers(db, userB.id)).toHaveLength(1);
    expect(listMcpServers(db, userB.id)[0]!.id).toBe(serverId);
  });
});

describe('services screen chrome', () => {
  it('shows a friendly empty state when nothing is connected', async () => {
    const res = await app.inject({ method: 'GET', url: '/mcp', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('class="empty"');
    expect(res.body).toContain('No services connected yet');
    expect(res.body).toContain('aria-current="page"'); // Services nav active
  });

  it('renders a saved flash on /mcp?saved=connected', async () => {
    const res = await app.inject({ method: 'GET', url: '/mcp?saved=connected', headers: { cookie } });
    expect(res.body).toContain('flash-ok');
  });
});
