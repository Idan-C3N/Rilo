import { describe, it, expect, beforeEach } from 'vitest';
import { getModelIds, resolveDefaultModels, fetchCatalog, resetCatalogCache } from '../../src/openrouter/catalog.js';

const DATA = {
  data: [
    { id: 'anthropic/claude-haiku-4.5', pricing: { completion: '0.000004' } },
    { id: 'anthropic/claude-sonnet-5', pricing: { completion: '0.000015' } },
    { id: 'anthropic/claude-opus-4.8', pricing: { completion: '0.000075' } },
    { id: 'openai/gpt-5', pricing: { completion: '0.00001' } },
  ],
};
function okFetch(counter?: { n: number }) {
  return (async () => {
    if (counter) counter.n++;
    return { ok: true, json: async () => DATA } as any;
  }) as any;
}

beforeEach(() => resetCatalogCache());

describe('catalog', () => {
  it('getModelIds returns all ids sorted', async () => {
    expect(await getModelIds(okFetch())).toEqual([
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-5',
      'openai/gpt-5',
    ]);
  });

  it('resolveDefaultModels picks cheapest + median within the family', async () => {
    expect(await resolveDefaultModels('anthropic/', okFetch())).toEqual({
      cheap_model: 'anthropic/claude-haiku-4.5', // cheapest
      strong_model: 'anthropic/claude-sonnet-5', // median of 3 (index 1)
    });
  });

  it('family filter excludes other providers', async () => {
    const r = await resolveDefaultModels('openai/', okFetch());
    expect(r).toEqual({ cheap_model: 'openai/gpt-5', strong_model: 'openai/gpt-5' }); // n=1
  });

  it('unknown family → undefined', async () => {
    expect(await resolveDefaultModels('mistral/', okFetch())).toBeUndefined();
  });

  it('caches within TTL — second call does not re-fetch', async () => {
    const c = { n: 0 };
    await fetchCatalog(okFetch(c));
    await fetchCatalog(okFetch(c)); // different fn, but cache should short-circuit before calling it
    expect(c.n).toBe(1);
  });

  it('fetch throwing → empty ids and undefined defaults', async () => {
    const boom = (async () => { throw new Error('network'); }) as any;
    expect(await getModelIds(boom)).toEqual([]);
    resetCatalogCache();
    expect(await resolveDefaultModels('anthropic/', boom)).toBeUndefined();
  });

  it('non-ok response → empty', async () => {
    const notOk = (async () => ({ ok: false, json: async () => ({} as any) } as any)) as any;
    expect(await getModelIds(notOk)).toEqual([]);
  });
});
