import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import { addMcpServer, listMcpServers, setMcpEnabled, deleteMcpServer, type McpTransport } from '../../db/mcp.js';
import { layout, esc } from '../render.js';

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
        'MCP Servers',
        `${rows || '<p>No servers yet.</p>'}
        <div class="card"><h2>Add server</h2>
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
        </form></div>`,
      ),
    );
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
