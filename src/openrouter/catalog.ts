const ENDPOINT = 'https://openrouter.ai/api/v1/models';
const TTL_MS = 60 * 60 * 1000;
/** New-user default seeding ignores models older than this (recency guard). */
const RECENCY_MS = 365 * 24 * 60 * 60 * 1000;

export type FetchImpl = typeof fetch;
export interface CatalogModel {
  id: string;
  completionPrice: number;
  /** Unix seconds the model was published on OpenRouter (0 if unknown). */
  created: number;
}

interface CacheEntry {
  at: number;
  models: CatalogModel[];
}
let cache: CacheEntry | undefined;

/** Test-only: clear the in-memory cache so cases don't leak into each other. */
export function resetCatalogCache(): void {
  cache = undefined;
}

export async function fetchCatalog(fetchImpl: FetchImpl = fetch): Promise<CatalogModel[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models;
  try {
    const res = await fetchImpl(ENDPOINT);
    if (!res.ok) return cache?.models ?? [];
    const json = (await res.json()) as {
      data?: Array<{ id?: string; created?: number; pricing?: { completion?: string } }>;
    };
    const models: CatalogModel[] = (json.data ?? [])
      .filter((m): m is { id: string; created?: number; pricing?: { completion?: string } } => typeof m.id === 'string')
      .map((m) => ({ id: m.id, completionPrice: Number(m.pricing?.completion), created: Number(m.created) || 0 }));
    cache = { at: Date.now(), models };
    return models;
  } catch {
    return cache?.models ?? [];
  }
}

export async function getModelIds(fetchImpl: FetchImpl = fetch): Promise<string[]> {
  const models = await fetchCatalog(fetchImpl);
  return [...new Set(models.map((m) => m.id))].sort();
}

/**
 * Derive sane new-user defaults from the live catalog — no maintained slug list.
 * Price alone is misleading (old models are cheap), so we use the `created` date:
 *   - strong = the NEWEST model in the family (current-flagship proxy)
 *   - cheap  = the cheapest model created within the last year (recency guard drops
 *              legacy low-cost models); if none is recent, the cheapest overall.
 * `nowMs` is injectable for tests; it defaults to the real clock.
 */
export async function resolveDefaultModels(
  family: string,
  fetchImpl: FetchImpl = fetch,
  nowMs: number = Date.now(),
): Promise<{ cheap_model: string; strong_model: string } | undefined> {
  const fam = (await fetchCatalog(fetchImpl)).filter(
    (m) => m.id.startsWith(family) && Number.isFinite(m.completionPrice),
  );
  if (fam.length === 0) return undefined;
  const strong = fam.reduce((a, b) => (b.created > a.created ? b : a));
  const cutoff = nowMs - RECENCY_MS;
  const recent = fam.filter((m) => m.created * 1000 >= cutoff);
  const pool = recent.length > 0 ? recent : fam;
  const cheap = pool.reduce((a, b) => (b.completionPrice < a.completionPrice ? b : a));
  return { cheap_model: cheap.id, strong_model: strong.id };
}
