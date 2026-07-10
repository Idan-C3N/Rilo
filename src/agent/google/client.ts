import { OAuth2Client } from 'google-auth-library';

export type TokenProvider = () => Promise<string>;

/**
 * Build a function that returns a fresh Google access token for a user, given
 * the instance OAuth client credentials + the user's refresh token. The
 * OAuth2Client refreshes the access token automatically as needed.
 */
export function makeGoogleTokenProvider(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): TokenProvider {
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials({ refresh_token: refreshToken });
  return async () => {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('failed to obtain Google access token');
    return token;
  };
}

/** Scopes the loopback helper must request so these tools work. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
];
