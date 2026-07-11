import { describe, it, expect, beforeEach } from 'vitest';
import { getModelIds, resolveDefaultModels, fetchCatalog, resetCatalogCache } from '../../src/openrouter/catalog.js';

// created values are unix seconds; NOW is a fixed 2026-07-11 for deterministic
// recency-window math (resolveDefaultModels takes nowMs as its 3rd arg).
const NOW = 1_783_900_800_000; // 2026-07-11
const DATA = {
  data: [
    { id: 'anthropic/claude-3-haiku', created: 1_710_288_000, pricing: { completion: '0.0000012' } }, // 2024-03, legacy & cheapest
    { id: 'anthropic/claude-haiku-4.5', created: 1_760_486_400, pricing: { completion: '0.000005' } }, // 2025-10, recent cheap
    { id: 'anthropic/claude-sonnet-5', created: 1_782_777_600, pricing: { completion: '0.00001' } }, // 2026-06-30, newest
    { id: 'anthropic/claude-opus-4.8', created: 1_779_000_000, pricing: { completion: '0.000025' } }, // 2026, recent pricey
    { id: 'openai/gpt-5', created: 1_780_000_000, pricing: { completion: '0.00001' } },
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
      'anthropic/claude-3-haiku',
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-5',
      'openai/gpt-5',
    ]);
  });

  it('strong = newest in family; cheap = cheapest within the recency window (legacy excluded)', async () => {
    expect(await resolveDefaultModels('anthropic/', okFetch(), NOW)).toEqual({
      cheap_model: 'anthropic/claude-haiku-4.5', // cheapest RECENT (claude-3-haiku is cheaper but 2024 → excluded)
      strong_model: 'anthropic/claude-sonnet-5', // newest by created
    });
  });

  it('falls back to cheapest-overall when nothing is within the recency window', async () => {
    const FAR = 1_900_000_000_000; // far future → every model is "old"
    expect(await resolveDefaultModels('anthropic/', okFetch(), FAR)).toEqual({
      cheap_model: 'anthropic/claude-3-haiku', // no recent models → cheapest overall
      strong_model: 'anthropic/claude-sonnet-5', // newest is still newest
    });
  });

  it('family filter excludes other providers', async () => {
    const r = await resolveDefaultModels('openai/', okFetch(), NOW);
    expect(r).toEqual({ cheap_model: 'openai/gpt-5', strong_model: 'openai/gpt-5' }); // n=1
  });

  it('unknown family → undefined', async () => {
    expect(await resolveDefaultModels('mistral/', okFetch(), NOW)).toBeUndefined();
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
