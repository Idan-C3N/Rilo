import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyByToken } from '../../src/db/sessions.js';
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
  const { token } = startLogin(db, uid);
  cookie = `token=${verifyByToken(db, token)}`;
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

  it('shows the paste form when ENABLE_WEB_OAUTH is off (default)', async () => {
    const gApp = await buildWebApp({ db, appCfg: { googleClientId: 'c', googleClientSecret: 's' } as any });
    const res = await gApp.inject({ method: 'GET', url: '/mcp', headers: { cookie } });
    expect(res.body).toContain('Connect Google'); // paste form submit button
    expect(res.body).toContain('name="refresh_token"');
    expect(res.body).not.toContain('/oauth/google/start');
  });

  it('shows a Connect-with-Google link (no paste form) when ENABLE_WEB_OAUTH is on', async () => {
    const gApp = await buildWebApp({
      db,
      appCfg: { googleClientId: 'c', googleClientSecret: 's', enableWebOauth: true, webBaseUrl: 'https://rilo.example' } as any,
    });
    const res = await gApp.inject({ method: 'GET', url: '/mcp', headers: { cookie } });
    expect(res.body).toContain('/oauth/google/start');
    expect(res.body).toContain('Connect with Google');
    expect(res.body).not.toContain('name="refresh_token"');
  });
});

describe('mcp route', () => {
  it('POST /mcp custom-server route is removed', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mcp', headers: { cookie },
      payload: { name: 'x', transport: 'stdio', command: '/bin/sh' },
    });
    expect(res.statusCode).toBe(404); // route no longer exists
  });

  it('toggles and deletes a server', async () => {
    addMcpServer(db, uid, { name: 's', transport: 'stdio', command: 'node', args: ['x.js'] });
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

  it('renders an error flash from /mcp?error=... (escaped) for the OAuth failure path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/mcp?error=${encodeURIComponent('Authorization could not be verified. <b>x</b>')}`,
      headers: { cookie },
    });
    expect(res.body).toContain('flash-error');
    expect(res.body).toContain('Authorization could not be verified.');
    expect(res.body).not.toContain('<b>x</b>'); // escaped, not raw HTML
  });
});

describe('htmx region swap', () => {
  it('plain toggle still redirects (no-JS fallback)', async () => {
    const { addMcpServer } = await import('../../src/db/mcp.js');
    addMcpServer(db, uid, { name: 'S', transport: 'stdio', command: 'x', args: [] });
    const id = (await import('../../src/db/mcp.js')).listMcpServers(db, uid)[0]!.id;
    const res = await app.inject({ method: 'POST', url: `/mcp/${id}/toggle`, headers: { cookie } });
    expect(res.statusCode).toBe(302);
  });

  it('htmx toggle returns the #services region with the flipped state', async () => {
    const { addMcpServer, listMcpServers } = await import('../../src/db/mcp.js');
    addMcpServer(db, uid, { name: 'S', transport: 'stdio', command: 'x', args: [] });
    const id = listMcpServers(db, uid)[0]!.id;
    const res = await app.inject({
      method: 'POST', url: `/mcp/${id}/toggle`,
      headers: { cookie, 'hx-request': 'true' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="services">');
    expect(res.body).toContain('Enable'); // was enabled by default → now disabled → shows "Enable"
  });

  it('htmx delete returns the region without the deleted service', async () => {
    const { addMcpServer, listMcpServers } = await import('../../src/db/mcp.js');
    addMcpServer(db, uid, { name: 'ZapService', transport: 'stdio', command: 'x', args: [] });
    const id = listMcpServers(db, uid)[0]!.id;
    const res = await app.inject({
      method: 'POST', url: `/mcp/${id}/delete`,
      headers: { cookie, 'hx-request': 'true' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="services">');
    expect(res.body).not.toContain('ZapService');
  });

  it('htmx google connect returns the region showing the connected card', async () => {
    const gApp = await buildWebApp({
      db, getModels: async () => [],
      appCfg: { googleClientId: 'x', googleClientSecret: 'y' } as any,
    });
    const res = await gApp.inject({
      method: 'POST', url: '/google/connect',
      headers: { cookie, 'hx-request': 'true' },
      payload: { refresh_token: '1//abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="services">');
    expect(res.body).toContain('Disconnect');
  });
});
