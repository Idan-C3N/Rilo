import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import { addMcpServer, listMcpServers, setMcpEnabled, deleteMcpServer, type McpTransport } from '../../db/mcp.js';
import { MCP_PRESETS, getPreset } from '../../mcp/presets.js';
import { layout, esc } from '../render.js';

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
  return `<h2>Connect a service</h2>${cards}`;
}

const BUILTIN_SECTION = `<h2>Built in</h2>
  <div class="card"><b>🔎 Web Search</b> — always on, no setup needed.</div>`;

function parseCreds(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function registerMcpRoutes(app: FastifyInstance, db: DB): void {
  app.get('/mcp', async (req, reply) => {
    const userId = (req as any).userId as number;
    const servers = listMcpServers(db, userId);
    const rows = servers
      .map(
        (s) => `<div class="card"><b>${esc(s.name)}</b> (${esc(s.transport)}) ${s.enabled ? '🟢' : '⚪️'}
        <div>${esc(s.url ?? s.command ?? '')}</div>
        <form method="post" action="/mcp/${s.id}/toggle" style="display:inline"><button>${s.enabled ? 'Disable' : 'Enable'}</button></form>
        <form method="post" action="/mcp/${s.id}/delete" style="display:inline"><button>Delete</button></form>
        </div>`,
      )
      .join('');
    reply.type('text/html').send(
      layout(
        'Services',
        `${BUILTIN_SECTION}
        <h2>Your services</h2>
        ${rows || '<p>No services connected yet.</p>'}
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
    reply.redirect('/mcp');
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
      reply.redirect('/mcp');
    },
  );

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
    reply.redirect('/mcp');
  });
}
