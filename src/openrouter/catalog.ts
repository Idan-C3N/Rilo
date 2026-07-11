const ENDPOINT = 'https://openrouter.ai/api/v1/models';
const TTL_MS = 60 * 60 * 1000;

export type FetchImpl = typeof fetch;
export interface CatalogModel {
  id: string;
  completionPrice: number;
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
    const json = (await res.json()) as { data?: Array<{ id?: string; pricing?: { completion?: string } }> };
    const models: CatalogModel[] = (json.data ?? [])
      .filter((m): m is { id: string; pricing?: { completion?: string } } => typeof m.id === 'string')
      .map((m) => ({ id: m.id, completionPrice: Number(m.pricing?.completion) }));
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

export async function resolveDefaultModels(
  family: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ cheap_model: string; strong_model: string } | undefined> {
  const models = (await fetchCatalog(fetchImpl))
    .filter((m) => m.id.startsWith(family) && Number.isFinite(m.completionPrice))
    .sort((a, b) => a.completionPrice - b.completionPrice);
  if (models.length === 0) return undefined;
  return {
    cheap_model: models[0]!.id,
    strong_model: models[Math.floor(models.length / 2)]!.id,
  };
}
