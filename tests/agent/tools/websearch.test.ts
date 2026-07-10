import { describe, it, expect } from 'vitest';
import { makeWebSearchTool, type SearchFn } from '../../../src/agent/tools/websearch.js';
import { buildToolsFor } from '../../../src/agent/tools/index.js';
import { openDb, type DB } from '../../../src/db/db.js';
import { createUserWithIdentity } from '../../../src/db/users.js';

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
