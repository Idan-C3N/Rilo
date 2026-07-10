import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { makeGoogleTools } from '../../../src/agent/tools/google.js';
import { buildToolsFor } from '../../../src/agent/tools/index.js';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUserWithIdentity } from '../../../src/db/users.js';
import { initCrypto } from '../../../src/crypto/encryption.js';
import { setOAuthToken } from '../../../src/db/oauth.js';

const getToken = async () => 'access-tok';

/** Build a fake fetch that routes by URL substring. */
function fakeFetch(routes: Array<{ match: string; status?: number; json: any }>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const r = routes.find((x) => url.includes(x.match));
    if (!r) throw new Error(`unexpected url ${url}`);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.json),
    } as any;
  }) as unknown as typeof fetch;
}

describe('google tools', () => {
  it('gmail_search lists messages with headers + snippet', async () => {
    const fetchImpl = fakeFetch([
      { match: '/messages?q=', json: { messages: [{ id: 'm1' }] } },
      {
        match: '/messages/m1',
        json: { snippet: 'hi there', payload: { headers: [
          { name: 'From', value: 'boss@x.com' },
          { name: 'Subject', value: 'Standup' },
          { name: 'Date', value: 'Fri, 10 Jul 2026' },
        ] } },
      },
    ]);
    const tools = makeGoogleTools({ getToken, fetchImpl });
    const res = await (tools.gmail_search as any).execute({ query: 'is:unread', max_results: 5 });
    expect(res.messages).toEqual([
      { id: 'm1', from: 'boss@x.com', subject: 'Standup', date: 'Fri, 10 Jul 2026', snippet: 'hi there' },
    ]);
  });

  it('calendar_create posts an event and returns id', async () => {
    const fetchImpl = fakeFetch([{ match: '/events', json: { id: 'ev1', htmlLink: 'http://cal/ev1' } }]);
    const tools = makeGoogleTools({ getToken, fetchImpl });
    const res = await (tools.calendar_create as any).execute({
      summary: 'Coffee', start: '2026-07-12T15:00:00+03:00', end: '2026-07-12T15:30:00+03:00',
    });
    expect(res).toEqual({ ok: true, id: 'ev1', htmlLink: 'http://cal/ev1' });
  });

  it('returns an error object (no throw) on API failure', async () => {
    const fetchImpl = fakeFetch([{ match: '/messages', status: 401, json: { error: 'bad token' } }]);
    const tools = makeGoogleTools({ getToken, fetchImpl });
    const res = await (tools.gmail_search as any).execute({ query: 'x' });
    expect(res.error).toMatch(/401/);
  });
});

describe('buildToolsFor google wiring', () => {
  let db: DB, uid: number;
  beforeAll(async () => {
    await sodium.ready;
    await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
  });
  beforeEach(() => {
    db = openDb(':memory:');
    uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
  });
  const noop = async () => ({ tools: {}, closeAll: async () => {} });

  it('omits google tools when the user has not connected', async () => {
    const { tools } = await buildToolsFor({ db, userId: uid, google: { clientId: 'c', clientSecret: 's' }, assemble: noop });
    expect(tools.gmail_search).toBeUndefined();
  });

  it('includes google tools when instance creds + user token exist', async () => {
    setOAuthToken(db, uid, 'google', 'refresh-tok');
    const { tools } = await buildToolsFor({ db, userId: uid, google: { clientId: 'c', clientSecret: 's' }, assemble: noop });
    expect(tools.gmail_search).toBeDefined();
    expect(tools.calendar_list).toBeDefined();
  });
});
