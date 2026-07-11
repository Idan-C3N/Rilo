/**
 * One-time Google OAuth loopback helper. This is the fallback used when
 * ENABLE_WEB_OAUTH is off (the default) — run it locally to obtain a refresh
 * token to paste into Rilo (Services → Connect Google). Keeps the VPS
 * firewall-only — no public callback needed. (With ENABLE_WEB_OAUTH=true the
 * Services page instead offers a one-click "Connect with Google" button.)
 *
 * Usage (from the repo root, with GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env):
 *   node --env-file=.env --import tsx scripts/google-auth.ts
 *
 * Your Google Cloud OAuth client must be of type "Desktop app" (those allow
 * loopback redirects on any 127.0.0.1 port).
 */
import http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_SCOPES } from '../src/agent/google/client.js';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (e.g. in .env) first.');
  process.exit(1);
}

const port = Number(process.env.OAUTH_PORT ?? 4567);
const redirectUri = `http://127.0.0.1:${port}`;
const client = new OAuth2Client({ clientId, clientSecret, redirectUri });

const authUrl = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // force a refresh_token every run
  scope: GOOGLE_SCOPES,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', redirectUri);
  const code = url.searchParams.get('code');
  if (!code) {
    res.statusCode = 400;
    res.end('Missing ?code');
    return;
  }
  try {
    const { tokens } = await client.getToken(code);
    res.end('Authorized ✅  Copy the refresh token from your terminal into Rilo, then close this tab.');
    if (tokens.refresh_token) {
      console.log('\n=== REFRESH TOKEN — paste into Rilo → Services → Connect Google ===\n');
      console.log(tokens.refresh_token);
      console.log('\n==================================================================\n');
    } else {
      console.error('\nNo refresh_token returned. Revoke access at https://myaccount.google.com/permissions and re-run.\n');
    }
  } catch (err) {
    res.statusCode = 500;
    res.end('Token exchange failed — see terminal.');
    console.error(err);
  } finally {
    setTimeout(() => server.close(() => process.exit(0)), 500);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('\nOpen this URL in your browser to authorize Rilo:\n');
  console.log(authUrl + '\n');
});
