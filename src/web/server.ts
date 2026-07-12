import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { sessionUserId } from './auth.js';
import { verifyByToken } from '../db/sessions.js';
import { registerHomeRoutes } from './routes/home.js';
import { registerModelsRoutes } from './routes/models.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerOauthRoutes, type MakeOauthClient } from './routes/oauth.js';
import { registerRegisterRoutes } from './routes/register.js';
import { registerPendingRoutes } from './routes/pending.js';
import { layout, flash } from './render.js';
import { getModelIds } from '../openrouter/catalog.js';

export interface WebDeps {
  db: DB;
  appCfg: Pick<
    AppConfig,
    | 'openrouterKeyFallback'
    | 'googleClientId'
    | 'googleClientSecret'
    | 'enableWebOauth'
    | 'webBaseUrl'
    | 'encKey'
  >;
  getModels?: () => Promise<string[]>;
  /** Injectable OAuth client factory (tests stub the token exchange). */
  makeOauthClient?: MakeOauthClient;
  /** Build the registration deep link (wired from the channel adapter). */
  registrationLink?: (code: string) => string;
  /** Notify a requester over their channel on approve/deny (best-effort). */
  notify?: (channelUserId: string, text: string) => Promise<void>;
}

// Vendored htmx, read once at startup and served from memory (no build step).
const HTMX_JS = readFileSync(new URL('./vendor/htmx.min.js', import.meta.url), 'utf8');

const PUBLIC_PATHS = new Set(['/login', '/register', '/vendor/htmx.min.js', '/oauth/google/callback']);

export async function buildWebApp(deps: WebDeps): Promise<FastifyInstance> {
  const app = Fastify();
  // Secret enables signed cookies (the OAuth `state` cookie). Derive a
  // domain-separated signing key from ENC_KEY rather than reusing the raw
  // encryption key for a second purpose. Harmless when absent (only OAuth
  // signs cookies).
  const cookieSecret = deps.appCfg.encKey
    ? createHash('sha256').update(`rilo-cookie-sig:${deps.appCfg.encKey}`).digest('hex')
    : undefined;
  await app.register(cookie, { secret: cookieSecret });
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

  // Magic-link login: the link's token is the sole factor. GET verifies it,
  // rotates to a fresh session token, sets the cookie, and redirects home.
  app.get<{ Querystring: { token?: string } }>('/login', async (req, reply) => {
    if (req.query.token) {
      const sessionToken = verifyByToken(deps.db, req.query.token);
      if (sessionToken) {
        reply.setCookie('token', sessionToken, { path: '/', httpOnly: true, sameSite: 'lax' });
        reply.redirect('/');
        return;
      }
      reply.type('text/html').send(
        layout(
          'Login',
          `<div class="card">${flash('error', 'This login link is invalid or expired.')}
          <p class="muted">Send <code>/login</code> to Rilo on Telegram for a new one.</p></div>`,
          { bare: true },
        ),
      );
      return;
    }
    reply.type('text/html').send(
      layout(
        'Login',
        `<div class="card"><h2>Check Telegram</h2>
        <p class="muted">Open the login link Rilo sent you on Telegram to sign in.</p></div>`,
        { bare: true },
      ),
    );
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
    enableWebOauth: !!deps.appCfg.enableWebOauth,
  });
  registerOauthRoutes(app, deps.db, {
    enableWebOauth: !!deps.appCfg.enableWebOauth,
    webBaseUrl: deps.appCfg.webBaseUrl,
    googleClientId: deps.appCfg.googleClientId,
    googleClientSecret: deps.appCfg.googleClientSecret,
    makeClient: deps.makeOauthClient,
  });
  registerRegisterRoutes(app, deps.db, {
    registrationLink: deps.registrationLink ?? ((code) => `/register?code=${code}`),
  });
  registerPendingRoutes(app, deps.db, { notify: deps.notify });
  return app;
}

export async function startWeb(deps: WebDeps & { port: number }): Promise<{ close(): Promise<void> }> {
  const app = await buildWebApp(deps);
  await app.listen({ host: '0.0.0.0', port: deps.port });
  return { close: () => app.close() };
}
