# OpenRouter Model Catalog — Design

**Date:** 2026-07-11
**Relation:** Extends the web-UI workstream (#2); adds a shared catalog used by the
Models screen and by new-user default seeding.
**Status:** Approved design (via brainstorming Q&A), ready for plan.

## Goal

Stop new users and the Models UI from depending on hardcoded model slugs that can
become deprecated. Introduce a live OpenRouter model catalog and use it for:
- **(A)** the Models page: pick cheap/strong from a live `<select>` (free-text fallback);
- **(B)** new-user default seeding: derive tiers from the live catalog, no slug list to maintain.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Catalog source | Public `GET https://openrouter.ai/api/v1/models` — no API key/auth |
| Caching | In-memory, ~1h TTL, shared by (A) and (B); injectable fetch for tests |
| Tier derivation | Filter to a family, sort by `pricing.completion` asc: **cheap = cheapest**, **strong = median-priced** (`sorted[floor(n/2)]`) — data-derived, zero slug maintenance |
| Family | env **`DEFAULT_MODEL_FAMILY`** (default `"anthropic/"`) — the app is Claude-centric |
| Models widget | `<select>` populated from the catalog; current stored value preselected (prepended if not in list) |
| Failure fallback (A) | fetch fails/empty → render the current free-text `<input>` + a muted note; page never breaks |
| Failure fallback (B) | fetch fails / no family match → keep the SQL column defaults (ultimate safety net) |
| Default seeding point | resolve async in `dispatch` AFTER `createUserWithIdentity`, then `setModels` — keeps db layer sync/network-free |

## Non-goals

- No change to how models are *used* at runtime (`resolveModels` unchanged).
- No auth/key for the catalog fetch (endpoint is public).
- No client-side JS; the `<select>` is server-rendered.
- Dropdown lists ALL models (not just the family) — the family only governs default seeding.

## 1. Shared module `src/openrouter/catalog.ts`

```
type FetchImpl = typeof fetch;
interface CatalogModel { id: string; completionPrice: number }
```

- `fetchCatalog(fetchImpl?): Promise<CatalogModel[]>` — GET the endpoint; parse
  `data[].id` and `Number(data[].pricing.completion)` (USD/token; missing → `NaN`,
  treated as unpriced and excluded from tier math but kept for the id list). Populates
  an in-memory cache `{ at: number; models: CatalogModel[] }`; a second call within the
  TTL returns the cache. On HTTP error / network throw → returns `[]` (and does not
  poison the cache). The cache test just calls twice in quick succession (real TTL is
  ~1h, so it won't expire mid-test) and asserts the fake fetch ran once — no clock
  injection needed. A test-only `resetCatalogCache()` export lets tests isolate cases.
- `getModelIds(fetchImpl?): Promise<string[]>` — catalog ids, sorted, deduped. For (A).
- `resolveDefaultModels(family: string, fetchImpl?): Promise<{ cheap_model: string; strong_model: string } | undefined>`
  — filter catalog to `id.startsWith(family)` with a finite `completionPrice`, sort asc;
  `undefined` if empty; else `cheap = sorted[0].id`, `strong = sorted[floor(n/2)].id`.
  (n=1 → both the same; n=2 → cheap[0], strong[1].)

TTL and endpoint are module constants. Cache is process-global (fine: single process).

## 2. Config

`src/config.ts`: add `defaultModelFamily: string` = `env.DEFAULT_MODEL_FAMILY || 'anthropic/'`.
`.env.example`: add `DEFAULT_MODEL_FAMILY=   # optional; family prefix for seeding new-user model defaults (default anthropic/)`.

## 3. (A) Models page `<select>`

- `registerModelsRoutes` gains an injected `getModels: () => Promise<string[]>`
  (default the real `getModelIds`). `buildWebApp` passes the real one; tests pass a fake
  → no network in tests.
- `GET /models` becomes: `const ids = await getModels();`
  - `ids.length > 0` → render two `<select name="cheap_model">` / `strong_model` with an
    `<option>` per id; mark the user's current value `selected`; if the current value is
    not in `ids`, prepend it as a `selected` option (so a deprecated stored slug stays
    visible/selected).
  - `ids.length === 0` → render the existing free-text `<input>` for both, plus a muted
    line "Couldn't load the model list — enter a slug manually."
- POST handlers unchanged (still `setModels` + redirect `/models?saved=…`).

## 4. (B) New-user default seeding

- `DispatchDeps` gains optional `resolveDefaultModels?: () => Promise<{ cheap_model: string; strong_model: string } | undefined>`.
- In `handleInbound`, right after the `createUserWithIdentity(...)` branch:
  ```
  const seeded = await deps.resolveDefaultModels?.();
  if (seeded) setModels(db, user.id, seeded);
  ```
  (only when a new user was just created). On `undefined` (fetch failed / no family
  match / dep not wired) the SQL defaults stand.
- `index.ts` wires `resolveDefaultModels: () => resolveDefaultModels(appCfg.defaultModelFamily)`.

## 5. Wiring (`index.ts`)

- `buildWebApp`/`startWeb` deps: pass `getModels: () => getModelIds()`.
- `handleInbound` deps: pass `resolveDefaultModels` as above.

## 6. Testing (vitest, injected fakes — no network)

- **catalog.ts:** given a fake `fetchImpl` returning a canned `{ data: [...] }`:
  `getModelIds` returns sorted ids; `resolveDefaultModels('anthropic/')` picks
  cheapest + median by completion price; family filter excludes other providers;
  fetch-throws / non-ok → `getModelIds` `[]` and `resolveDefaultModels` `undefined`;
  cache: two calls → one fetch (assert call count) within TTL.
- **models route:** build the app with a fake `getModels`:
  - non-empty → body has `<select name="cheap_model"` and the current value `selected`;
  - a stored value absent from the list is still present + selected (prepended);
  - empty list → falls back to `<input name="cheap_model"` + the muted note.
- **dispatch seeding:** `handleInbound` for a brand-new identity with a fake
  `resolveDefaultModels` → the new user's `getConfig` reflects the seeded models; with
  `resolveDefaultModels` returning `undefined` → SQL defaults remain; existing users are
  not reseeded.
- Keep the whole suite + `npx tsc --noEmit` green.

## 7. Files & boundaries

- **New:** `src/openrouter/catalog.ts`, `tests/openrouter/catalog.test.ts`, `tests/web/models-select.test.ts` (or extend home-route test).
- **Modify:** `src/config.ts` (+`.env.example`), `src/web/server.ts` (+`WebDeps.getModels`, pass to models route), `src/web/routes/models.ts` (async select + fallback), `src/agent/dispatch.ts` (seed after create), `src/index.ts` (wiring), `tests/agent/dispatch.test.ts` (seeding cases).
- **Untouched:** `db/users.ts`, `agent/models.ts` (runtime resolution), scheduler, crypto.

## Risks / notes

- OpenRouter returns hundreds of models → the `<select>` is long but usable (sorted).
  Acceptable; a filter/type-ahead is out of scope (the free-text fallback + datalist
  could be revisited later).
- Median-as-strong depends on the family's price spread; if a family has few models the
  pick may equal cheap (n=1). The SQL default remains the floor.
- Registration adds one catalog fetch on first message from a new user (cached after);
  failure is swallowed → SQL defaults, so onboarding never blocks on OpenRouter.
