import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import { getConfig, getOpenrouterKey } from '../../db/config.js';
import { listMcpServers } from '../../db/mcp.js';
import { hasOAuthToken } from '../../db/oauth.js';
import { layout, esc } from '../render.js';

function statusRow(label: string, status: string, href: string): string {
  return `<div class="status-row"><span class="label">${esc(label)}</span>
    <span class="spacer"></span><span class="muted">${esc(status)}</span>
    <a href="${href}">Open</a></div>`;
}

export function registerHomeRoutes(
  app: FastifyInstance,
  db: DB,
  opts: { googleEnabled: boolean; hasOpenrouterFallback: boolean },
): void {
  app.get('/', async (req, reply) => {
    const userId = (req as any).userId as number;
    const cfg = getConfig(db, userId);
    const hasUserKey = !!getOpenrouterKey(db, userId);
    const keyStatus = hasUserKey
      ? 'Your key is set ✅'
      : opts.hasOpenrouterFallback
        ? 'Using the instance key ✅'
        : 'Not set ❌';
    const serviceCount =
      listMcpServers(db, userId).filter((s) => s.enabled).length +
      (opts.googleEnabled && hasOAuthToken(db, userId, 'google') ? 1 : 0);

    reply.type('text/html').send(
      layout(
        'Home',
        `<h1>Welcome to Rilo</h1>
        <section class="card"><h2>Getting started</h2>
          ${statusRow('OpenRouter key', keyStatus, '/models')}
          ${statusRow('Models', `${esc(cfg.cheap_model)} · ${esc(cfg.strong_model)}`, '/models')}
          ${statusRow('Services', `${serviceCount} connected`, '/mcp')}
        </section>`,
        { active: 'home' },
      ),
    );
  });
}
