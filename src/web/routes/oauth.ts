import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import type { DB } from '../../db/db.js';
import { setOAuthToken } from '../../db/oauth.js';
import { GOOGLE_SCOPES } from '../../agent/google/client.js';

/**
 * Minimal surface of google-auth-library's OAuth2Client that these routes use.
 * Declared as an interface so tests can inject a fake `getToken` without a
 * network round-trip.
 */
export interface OauthClientLike {
  generateAuthUrl(opts: { access_type: string; prompt: string; scope: string[]; state: string }): string;
  getToken(code: string): Promise<{ tokens: { refresh_token?: string | null } }>;
}

export type MakeOauthClient = (cfg: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) => OauthClientLike;

const defaultMakeClient: MakeOauthClient = (cfg) => new OAuth2Client(cfg) as unknown as OauthClientLike;

export interface OauthRouteOpts {
  enableWebOauth: boolean;
  webBaseUrl: string;
  googleClientId?: string;
  googleClientSecret?: string;
  makeClient?: MakeOauthClient;
}

const STATE_COOKIE = 'oauth_state';
const STATE_TTL_SEC = 600; // 10 minutes

/**
 * Provider-generic public OAuth authorization-code routes (only `google`
 * implemented). Entirely inert unless `enableWebOauth` is true AND Google
 * credentials are configured — the callback lives in PUBLIC_PATHS but performs
 * no write without a valid signed `state` cookie.
 */
export function registerOauthRoutes(app: FastifyInstance, db: DB, opts: OauthRouteOpts): void {
  const makeClient = opts.makeClient ?? defaultMakeClient;
  const configured = () =>
    opts.enableWebOauth && !!opts.googleClientId && !!opts.googleClientSecret;
  // Trailing slash on WEB_BASE_URL would produce `host//oauth/...` and fail
  // Google's exact redirect-URI match.
  const redirectUri = `${(opts.webBaseUrl ?? '').replace(/\/+$/, '')}/oauth/google/callback`;

  // Authenticated: the logged-in owner initiates consent.
  app.get('/oauth/google/start', async (req, reply) => {
    if (!configured()) {
      reply.redirect('/mcp');
      return;
    }
    const userId = (req as any).userId as number;
    const state = randomBytes(24).toString('base64url');
    const client = makeClient({
      clientId: opts.googleClientId!,
      clientSecret: opts.googleClientSecret!,
      redirectUri,
    });
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // force a refresh_token
      scope: GOOGLE_SCOPES,
      state,
    });
    // Bind state + initiating userId in one signed, httpOnly, short-lived cookie.
    reply.setCookie(STATE_COOKIE, `${state}.${userId}`, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax', // callback is a top-level cross-site redirect from Google
      secure: true,
      path: '/',
      maxAge: STATE_TTL_SEC,
    });
    reply.redirect(authUrl);
  });

  // Public path (arrives with no session cookie). Inert when the flag is off.
  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/oauth/google/callback',
    async (req, reply) => {
      if (!configured()) {
        reply.redirect('/mcp');
        return;
      }
      const fail = (msg: string) => reply.redirect(`/mcp?error=${encodeURIComponent(msg)}`);

      const raw = req.cookies[STATE_COOKIE];
      // Consume the one-shot state cookie regardless of outcome.
      reply.clearCookie(STATE_COOKIE, { path: '/' });
      if (!raw) return fail('Authorization expired. Please try connecting again.');

      const unsigned = req.unsignCookie(raw);
      if (!unsigned.valid || !unsigned.value) {
        return fail('Authorization could not be verified. Please try connecting again.');
      }
      const sep = unsigned.value.lastIndexOf('.');
      const cookieState = sep >= 0 ? unsigned.value.slice(0, sep) : '';
      const userId = Number(unsigned.value.slice(sep + 1));
      const { code, state } = req.query;
      if (!code || !state || state !== cookieState || !Number.isInteger(userId)) {
        return fail('Authorization could not be verified. Please try connecting again.');
      }

      try {
        const client = makeClient({
          clientId: opts.googleClientId!,
          clientSecret: opts.googleClientSecret!,
          redirectUri,
        });
        const { tokens } = await client.getToken(code);
        if (!tokens.refresh_token) {
          return fail(
            'Google did not return a refresh token. Revoke access at myaccount.google.com/permissions and try again.',
          );
        }
        setOAuthToken(db, userId, 'google', tokens.refresh_token);
      } catch {
        // Never leak exchange internals to the client.
        return fail('Could not complete Google authorization. Please try again.');
      }
      reply.redirect('/mcp?saved=google');
    },
  );
}
