import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import { addMcpServer, listMcpServers, setMcpEnabled, deleteMcpServer, type McpTransport } from '../../db/mcp.js';
import { MCP_PRESETS, getPreset } from '../../mcp/presets.js';
import { hasOAuthToken, setOAuthToken, deleteOAuthToken } from '../../db/oauth.js';
import { layout, esc, type Flash } from '../render.js';

/** Google card when CONNECTED (shown under "Your services"). Empty otherwise. */
function renderGoogleConnected(db: DB, userId: number, enabled: boolean): string {
  if (!enabled || !hasOAuthToken(db, userId, 'google')) return '';
  return `<div class="card"><b>📧 Google Workspace</b> — connected ✅ (Gmail + Calendar)
    <form method="post" action="/google/disconnect"><button class="btn-secondary">Disconnect</button></form></div>`;
}

/** Google card when NOT connected (shown under "Connect a service"). Empty otherwise. */
function renderGoogleConnect(db: DB, userId: number, enabled: boolean): string {
  if (!enabled || hasOAuthToken(db, userId, 'google')) return '';
  return `<div class="card"><b>📧 Google Workspace</b> — Gmail + Calendar
    <div>Connect once: run the loopback helper locally, then paste the refresh token here.</div>
    <ol>
      <li>From the repo: <code>node --env-file=.env --import tsx scripts/google-auth.ts</code></li>
      <li>Open the printed URL, approve access.</li>
      <li>Paste the refresh token it prints below.</li>
    </ol>
    <form method="post" action="/google/connect">
      <label>Refresh token<input name="refresh_token" type="password" placeholder="1//0..."></label>
      <button type="submit">Connect Google</button>
    </form></div>`;
}

/** Render the one-click preset catalog: a small card + form per preset. */
function renderPresets(): string {
  const cards = MCP_PRESETS.map((p) => {
    const fields = p.secrets
      .map(
        (s) =>
          `<label>${esc(s.label)}<input name="${esc(s.field)}" placeholder="${esc(s.placeholder ?? '')}"></label>`,
      )
      .join('');
    return `<div class="card">
      <b>${esc(p.label)}</b>
      <div>${esc(p.description)}</div>
      <form method="post" action="/mcp/preset">
        <input type="hidden" name="preset_id" value="${esc(p.id)}">
        ${fields}
        <button type="submit">Connect ${esc(p.label)}</button>
      </form>
    </div>`;
  }).join('');
  return cards;
}

const BUILTIN_SECTION = `<h2>Built in</h2>
  <div class="card"><b>🔎 Web Search</b> — always on, no setup needed.</div>`;

const SAVED_FLASH: Record<string, Flash> = {
  connected: { kind: 'ok', msg: 'Service connected ✅' },
  deleted: { kind: 'ok', msg: 'Service removed ✅' },
  google: { kind: 'ok', msg: 'Google connected ✅' },
};

function parseCreds(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function registerMcpRoutes(
  app: FastifyInstance,
  db: DB,
  opts: { googleEnabled: boolean } = { googleEnabled: false },
): void {
  app.get<{ Querystring: { saved?: string } }>('/mcp', async (req, reply) => {
    const userId = (req as any).userId as number;
    const servers = listMcpServers(db, userId);
    const googleConnected = renderGoogleConnected(db, userId, opts.googleEnabled);
    const googleConnect = renderGoogleConnect(db, userId, opts.googleEnabled);
    const rows = servers
      .map(
        (s) => `<div class="card"><b>${esc(s.name)}</b> (${esc(s.transport)}) ${s.enabled ? '🟢' : '⚪️'}
        <div class="muted">${esc(s.url ?? s.command ?? '')}</div>
        <form method="post" action="/mcp/${s.id}/toggle" class="inline-form"><button class="btn-secondary">${s.enabled ? 'Disable' : 'Enable'}</button></form>
        <form method="post" action="/mcp/${s.id}/delete" class="inline-form"><button class="btn-danger">Delete</button></form>
        </div>`,
      )
      .join('');
    const flash = req.query.saved ? SAVED_FLASH[req.query.saved] : undefined;
    reply.type('text/html').send(
      layout(
        'Services',
        `${BUILTIN_SECTION}
        <h2>Your services</h2>
        ${googleConnected}${rows}
        ${!googleConnected && !rows ? '<div class="empty">No services connected yet. Connect one below.</div>' : ''}
        <h2>Connect a service</h2>
        ${googleConnect}
        ${renderPresets()}
        <details><summary>Advanced: connect a custom MCP server manually</summary>
        <div class="card"><h3>Add server</h3>
        <form method="post" action="/mcp">
          <label>Name<input name="name" required></label>
          <label>Transport
            <select name="transport"><option value="stdio">stdio</option><option value="http">http</option><option value="sse">sse</option></select>
          </label>
          <label>Command (stdio)<input name="command" placeholder="node"></label>
          <label>Args (space-separated)<input name="args" placeholder="server.js --flag"></label>
          <label>URL (http/sse)<input name="url" placeholder="https://host/mcp"></label>
          <label>Creds (KEY=VALUE per line)<textarea name="creds" rows="3"></textarea></label>
          <button type="submit">Add</button>
        </form></div></details>`,
        { active: 'services', flash },
      ),
    );
  });

  // One-click add from the preset catalog: build the server row from the preset,
  // mapping provided secret fields into creds (a special `__url` field sets the
  // server URL for hosted MCPs rather than a credential).
  app.post<{ Body: Record<string, string> }>('/mcp/preset', async (req, reply) => {
    const userId = (req as any).userId as number;
    const preset = getPreset(req.body.preset_id ?? '');
    if (!preset) {
      reply.redirect('/mcp');
      return;
    }
    const creds: Record<string, string> = {};
    let url = preset.url;
    for (const s of preset.secrets) {
      const v = (req.body[s.field] ?? '').trim();
      if (!v) continue;
      if (s.field === '__url') url = v;
      else creds[s.field] = v;
    }
    addMcpServer(db, userId, {
      name: preset.label,
      transport: preset.transport,
      command: preset.command,
      args: preset.args ?? [],
      url: url || undefined,
      creds: Object.keys(creds).length ? creds : undefined,
    });
    reply.redirect('/mcp?saved=connected');
  });

  app.post<{ Body: { name: string; transport: McpTransport; command?: string; args?: string; url?: string; creds?: string } }>(
    '/mcp',
    async (req, reply) => {
      const userId = (req as any).userId as number;
      const b = req.body;
      addMcpServer(db, userId, {
        name: b.name,
        transport: b.transport,
        command: b.command || undefined,
        args: (b.args ?? '').split(/\s+/).filter(Boolean),
        url: b.url || undefined,
        creds: parseCreds(b.creds ?? ''),
      });
      reply.redirect('/mcp?saved=connected');
    },
  );

  app.post<{ Body: { refresh_token?: string } }>('/google/connect', async (req, reply) => {
    const userId = (req as any).userId as number;
    const rt = (req.body.refresh_token ?? '').trim();
    if (rt) setOAuthToken(db, userId, 'google', rt);
    reply.redirect('/mcp?saved=google');
  });

  app.post('/google/disconnect', async (req, reply) => {
    const userId = (req as any).userId as number;
    deleteOAuthToken(db, userId, 'google');
    reply.redirect('/mcp');
  });

  app.post<{ Params: { id: string } }>('/mcp/:id/toggle', async (req, reply) => {
    const userId = (req as any).userId as number;
    const server = listMcpServers(db, userId).find((s) => s.id === Number(req.params.id));
    if (server) setMcpEnabled(db, server.id, !server.enabled);
    reply.redirect('/mcp');
  });

  app.post<{ Params: { id: string } }>('/mcp/:id/delete', async (req, reply) => {
    const userId = (req as any).userId as number;
    const server = listMcpServers(db, userId).find((s) => s.id === Number(req.params.id));
    if (server) deleteMcpServer(db, server.id);
    reply.redirect('/mcp?saved=deleted');
  });
}
