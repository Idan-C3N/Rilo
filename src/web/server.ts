import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { sessionUserId } from './auth.js';
import { verifyCode } from '../db/sessions.js';
import { registerModelsRoutes } from './routes/models.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { layout } from './render.js';

export interface WebDeps {
  db: DB;
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>;
}

const PUBLIC_PATHS = new Set(['/login']);

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
        <form method="post" action="/login">
          <label>6-digit code<input name="code" inputmode="numeric" pattern="[0-9]{6}"></label>
          <button type="submit">Verify</button>
        </form></div>`,
      ),
    );
  });

  app.post<{ Body: { code: string } }>('/login', async (req, reply) => {
    const token = req.cookies.token;
    if (token && verifyCode(deps.db, token, req.body.code)) {
      reply.redirect('/');
    } else {
      reply.type('text/html').send(layout('Login', '<p>Invalid or expired code. <a href="/login">Try again</a></p>'));
    }
  });

  registerModelsRoutes(app, deps.db);
  registerMcpRoutes(app, deps.db);
  return app;
}

export async function startWeb(deps: WebDeps & { port: number }): Promise<{ close(): Promise<void> }> {
  const app = await buildWebApp(deps);
  await app.listen({ host: '0.0.0.0', port: deps.port });
  return { close: () => app.close() };
}
