import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { readFileSync } from 'node:fs';
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { sessionUserId } from './auth.js';
import { verifyCode } from '../db/sessions.js';
import { registerHomeRoutes } from './routes/home.js';
import { registerModelsRoutes } from './routes/models.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { layout, flash } from './render.js';
import { getModelIds } from '../openrouter/catalog.js';

export interface WebDeps {
  db: DB;
  appCfg: Pick<AppConfig, 'openrouterKeyFallback' | 'googleClientId' | 'googleClientSecret'>;
  getModels?: () => Promise<string[]>;
}

// Vendored htmx, read once at startup and served from memory (no build step).
const HTMX_JS = readFileSync(new URL('./vendor/htmx.min.js', import.meta.url), 'utf8');

const PUBLIC_PATHS = new Set(['/login', '/vendor/htmx.min.js']);

export async function buildWebApp(deps: WebDeps): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  await app.register(formbody);

  app.addHook('preHandler', async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split('?')[0]!)) return;
    const token = req.cookies.token;
    const userId = sessionUserId(deps.db, token);
    if (!userId) {
      reply.redirect('/login');
      return reply;
    }
    (req as any).userId = userId;
  });

  // Login: GET shows the code form (token comes from the query, stored in cookie), POST verifies.
  app.get<{ Querystring: { token?: string } }>('/login', async (req, reply) => {
    if (req.query.token) reply.setCookie('token', req.query.token, { path: '/', httpOnly: true });
    reply.type('text/html').send(
      layout(
        'Login',
        `<div class="card"><h2>Enter your code</h2>
        <p class="muted">Enter the 6-digit code Rilo sent you.</p>
        <form method="post" action="/login">
          <label>6-digit code<input name="code" inputmode="numeric" pattern="[0-9]{6}" autofocus></label>
          <button type="submit">Verify</button>
        </form></div>`,
        { bare: true },
      ),
    );
  });

  app.post<{ Body: { code: string } }>('/login', async (req, reply) => {
    const token = req.cookies.token;
    if (token && verifyCode(deps.db, token, req.body.code)) {
      reply.redirect('/');
    } else {
      reply.type('text/html').send(
        layout(
          'Login',
          `<div class="card">${flash('error', 'Invalid or expired code.')}
          <a href="/login">Try again</a></div>`,
          { bare: true },
        ),
      );
    }
  });

  app.get('/logout', async (_req, reply) => {
    reply.clearCookie('token', { path: '/' });
    reply.redirect('/login');
  });

  app.get('/vendor/htmx.min.js', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.type('application/javascript').send(HTMX_JS);
  });

  registerHomeRoutes(app, deps.db, {
    googleEnabled: !!(deps.appCfg.googleClientId && deps.appCfg.googleClientSecret),
    hasOpenrouterFallback: !!deps.appCfg.openrouterKeyFallback,
  });
  registerModelsRoutes(app, deps.db, deps.getModels ?? getModelIds);
  registerMcpRoutes(app, deps.db, {
    googleEnabled: !!(deps.appCfg.googleClientId && deps.appCfg.googleClientSecret),
  });
  return app;
}

export async function startWeb(deps: WebDeps & { port: number }): Promise<{ close(): Promise<void> }> {
  const app = await buildWebApp(deps);
  await app.listen({ host: '0.0.0.0', port: deps.port });
  return { close: () => app.close() };
}
