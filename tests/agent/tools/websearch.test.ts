import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  makeWebSearchTool,
  searxngSearch,
  googleSearch,
  selectSearchBackend,
  type SearchFn,
} from '../../../src/agent/tools/websearch.js';
import { buildToolsFor } from '../../../src/agent/tools/index.js';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUserWithIdentity } from '../../../src/db/users.js';

/** Install a fake global fetch that records the requested URL and returns `body`. */
function stubFetch(body: unknown, opts: { ok?: boolean; status?: number; text?: string } = {}) {
  const calls: string[] = [];
  const fake = vi.fn(async (url: unknown) => {
    calls.push(String(url));
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => body,
      text: async () => opts.text ?? '',
    } as Response;
  });
  vi.stubGlobal('fetch', fake);
  return { calls };
}

describe('web_search tool', () => {
  it('returns results from the injected search backend', async () => {
    const fake: SearchFn = async (query, max) => {
      expect(query).toBe('cyber jobs tel aviv');
      expect(max).toBe(3);
      return [{ title: 'Cyera Careers', url: 'https://cyera.io/careers', content: 'open roles' }];
    };
    const res = await (makeWebSearchTool(fake) as any).execute({ query: 'cyber jobs tel aviv', max_results: 3 });
    expect(res.results).toEqual([{ title: 'Cyera Careers', url: 'https://cyera.io/careers', content: 'open roles' }]);
  });

  it('returns an error object (does not throw) when the backend fails', async () => {
    const boom: SearchFn = async () => {
      throw new Error('network down');
    };
    const res = await (makeWebSearchTool(boom) as any).execute({ query: 'x' });
    expect(res.error).toMatch(/network down/);
  });
});

describe('searxngSearch backend', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls ${base}/search?q=...&format=json and maps results, slicing to maxResults', async () => {
    const { calls } = stubFetch({
      results: [
        { title: 'A', url: 'https://a.example', content: 'snip a' },
        { title: 'B', url: 'https://b.example', content: 'snip b' },
        { title: 'C', url: 'https://c.example', content: 'snip c' },
      ],
    });
    const results = await searxngSearch('http://searxng:8080')('open source llm', 2);
    expect(calls[0]).toBe('http://searxng:8080/search?q=open%20source%20llm&format=json');
    expect(results).toEqual([
      { title: 'A', url: 'https://a.example', content: 'snip a' },
      { title: 'B', url: 'https://b.example', content: 'snip b' },
    ]);
  });

  it('normalizes a single trailing slash on baseUrl', async () => {
    const { calls } = stubFetch({ results: [] });
    await searxngSearch('http://searxng:8080/')('q', 5);
    expect(calls[0]).toBe('http://searxng:8080/search?q=q&format=json');
  });

  it('fills missing fields with empty strings', async () => {
    stubFetch({ results: [{ title: 'only title' }] });
    const results = await searxngSearch('http://searxng:8080')('q', 5);
    expect(results).toEqual([{ title: 'only title', url: '', content: '' }]);
  });

  it('throws on a non-OK response', async () => {
    stubFetch({}, { ok: false, status: 502, text: 'bad gateway' });
    await expect(searxngSearch('http://searxng:8080')('q', 5)).rejects.toThrow(
      /SearXNG search failed: 502 bad gateway/,
    );
  });
});

describe('googleSearch backend', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls the customsearch endpoint with key, cx, q, num and maps items', async () => {
    const { calls } = stubFetch({
      items: [
        { title: 'G1', link: 'https://g1.example', snippet: 'snip 1' },
        { title: 'G2', link: 'https://g2.example', snippet: 'snip 2' },
      ],
    });
    const results = await googleSearch('KEY', 'CX')('hello world', 5);
    const url = calls[0];
    expect(url).toContain('https://www.googleapis.com/customsearch/v1?');
    expect(url).toContain('key=KEY');
    expect(url).toContain('cx=CX');
    expect(url).toContain('q=hello%20world');
    expect(url).toContain('num=5');
    expect(results).toEqual([
      { title: 'G1', url: 'https://g1.example', content: 'snip 1' },
      { title: 'G2', url: 'https://g2.example', content: 'snip 2' },
    ]);
  });

  it('clamps num to 10 when maxResults exceeds 10', async () => {
    const { calls } = stubFetch({ items: [] });
    await googleSearch('KEY', 'CX')('q', 25);
    expect(calls[0]).toContain('num=10');
  });

  it('fills missing fields with empty strings', async () => {
    stubFetch({ items: [{ title: 'only' }] });
    const results = await googleSearch('KEY', 'CX')('q', 5);
    expect(results).toEqual([{ title: 'only', url: '', content: '' }]);
  });

  it('throws on a non-OK response', async () => {
    stubFetch({}, { ok: false, status: 403, text: 'quota exceeded' });
    await expect(googleSearch('KEY', 'CX')('q', 5)).rejects.toThrow(
      /Google search failed: 403 quota exceeded/,
    );
  });
});

describe('selectSearchBackend precedence', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns undefined when nothing is configured (no searxngUrl)', () => {
    expect(selectSearchBackend({})).toBeUndefined();
  });

  it('defaults to SearXNG when searxngUrl is set and no other config', async () => {
    const { calls } = stubFetch({ results: [] });
    const fn = selectSearchBackend({ searxngUrl: 'http://searxng:8080' });
    expect(fn).toBeDefined();
    await fn!('q', 5);
    expect(calls[0]).toContain('searxng');
  });

  it('prefers Google over SearXNG when both google key and cx are set', async () => {
    // Distinguish backends by the URL the returned SearchFn fetches.
    const { calls } = stubFetch({ items: [] });
    const fn = selectSearchBackend({
      searxngUrl: 'http://searxng:8080',
      googleSearchKey: 'KEY',
      googleSearchCx: 'CX',
    });
    await fn!('q', 5);
    expect(calls[0]).toContain('customsearch');
  });

  it('does NOT pick Google when only the key is set (cx missing)', async () => {
    const { calls } = stubFetch({ results: [] });
    const fn = selectSearchBackend({ searxngUrl: 'http://searxng:8080', googleSearchKey: 'KEY' });
    await fn!('q', 5);
    expect(calls[0]).toContain('searxng');
  });

  it('does NOT auto-pick Tavily even when a Tavily key is present', async () => {
    const { calls } = stubFetch({ results: [] });
    const fn = selectSearchBackend({ searxngUrl: 'http://searxng:8080', tavilyApiKey: 'TK' });
    await fn!('q', 5);
    expect(calls[0]).toContain('searxng');
  });

  it('SEARCH_BACKEND=tavily forces Tavily', async () => {
    const { calls } = stubFetch({ results: [] });
    const fn = selectSearchBackend({ searchBackend: 'tavily', tavilyApiKey: 'TK' });
    await fn!('q', 5);
    expect(calls[0]).toContain('api.tavily.com');
  });

  it('SEARCH_BACKEND=google forces Google when key+cx present', async () => {
    const { calls } = stubFetch({ items: [] });
    const fn = selectSearchBackend({ searchBackend: 'google', googleSearchKey: 'K', googleSearchCx: 'C' });
    await fn!('q', 5);
    expect(calls[0]).toContain('customsearch');
  });

  it('SEARCH_BACKEND=searxng forces SearXNG', async () => {
    const { calls } = stubFetch({ results: [] });
    const fn = selectSearchBackend({ searchBackend: 'searxng', searxngUrl: 'http://searxng:8080' });
    await fn!('q', 5);
    expect(calls[0]).toContain('searxng');
  });

  it('throws a clear error when SEARCH_BACKEND=google but cx is missing', () => {
    expect(() => selectSearchBackend({ searchBackend: 'google', googleSearchKey: 'K' })).toThrow(
      /GOOGLE_SEARCH_KEY.*GOOGLE_SEARCH_CX|google/i,
    );
  });

  it('throws a clear error when SEARCH_BACKEND=tavily but key is missing', () => {
    expect(() => selectSearchBackend({ searchBackend: 'tavily' })).toThrow(/TAVILY_API_KEY|tavily/i);
  });

  it('throws a clear error when SEARCH_BACKEND=searxng but searxngUrl is missing', () => {
    expect(() => selectSearchBackend({ searchBackend: 'searxng' })).toThrow(/SEARXNG_URL|searxng/i);
  });

  it('throws on an unknown SEARCH_BACKEND value', () => {
    expect(() => selectSearchBackend({ searchBackend: 'bing' })).toThrow(/bing|unknown|SEARCH_BACKEND/i);
  });
});

describe('buildToolsFor web_search wiring', () => {
  let db: DB;
  const uid = () => createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;

  it('omits web_search when no backend/key is provided', async () => {
    db = openDb(':memory:');
    const noop = async () => ({ tools: {}, closeAll: async () => {} });
    const { tools } = await buildToolsFor({ db, userId: uid(), assemble: noop });
    expect(tools.web_search).toBeUndefined();
  });

  it('includes web_search when a search fn is provided', async () => {
    db = openDb(':memory:');
    const noop = async () => ({ tools: {}, closeAll: async () => {} });
    const search: SearchFn = async () => [];
    const { tools } = await buildToolsFor({ db, userId: uid(), search, assemble: noop });
    expect(tools.web_search).toBeDefined();
  });
});
