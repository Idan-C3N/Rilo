# OpenRouter Model Catalog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live, cached OpenRouter model catalog and use it for (A) a `<select>` on the Models page and (B) deriving new-user default models from live pricing, so no hardcoded slug can silently deprecate.

**Architecture:** New pure module `src/openrouter/catalog.ts` (injectable `fetch`, 1h in-memory cache). The Models route consumes it via an injected `getModels`; `dispatch` seeds new-user defaults via an injected `resolveDefaultModels` right after user creation (db layer stays sync). SQL column defaults remain the ultimate fallback.

**Tech Stack:** Node 22 / TypeScript / ESM (`.js` import paths), Fastify, vitest (injected fakes, no network). No new deps (uses global `fetch`).

## Global Constraints

- **No network in tests** — every catalog consumer takes an injectable fetcher; tests pass fakes.
- **Catalog endpoint:** `https://openrouter.ai/api/v1/models` (public, no auth). Response: `{ data: [{ id: string, pricing: { completion: string } }] }` (prices are USD/token strings).
- **Tier rule:** filter to family (`id.startsWith(family)`) with finite completion price, sort ascending → `cheap = sorted[0]`, `strong = sorted[floor(n/2)]`.
- **Family:** `env.DEFAULT_MODEL_FAMILY || 'anthropic/'`.
- **Failure is non-fatal:** catalog fetch failure → Models page falls back to free-text inputs; new-user seeding falls back to SQL defaults. Onboarding never blocks on OpenRouter.
- **Preserve existing softened copy** in models.ts (the OpenRouter-key line "No personal key yet — the instance key is used as a fallback.").
- ESM `.js` imports; TS strict incl. `noUncheckedIndexedAccess` (use `arr[i]!`). Keep suite + `npx tsc --noEmit` green before each commit.

---

### Task 1: Catalog module `src/openrouter/catalog.ts`

Pure, self-contained, injectable fetch + cache. No other files depend-on-yet.

**Files:**
- Create: `src/openrouter/catalog.ts`
- Test: `tests/openrouter/catalog.test.ts`

**Interfaces:**
- Produces:
  - `type FetchImpl = typeof fetch`
  - `interface CatalogModel { id: string; completionPrice: number }`
  - `resetCatalogCache(): void` (test isolation)
  - `fetchCatalog(fetchImpl?: FetchImpl): Promise<CatalogModel[]>`
  - `getModelIds(fetchImpl?: FetchImpl): Promise<string[]>`
  - `resolveDefaultModels(family: string, fetchImpl?: FetchImpl): Promise<{ cheap_model: string; strong_model: string } | undefined>`

- [ ] **Step 1: Write the failing test** — `tests/openrouter/catalog.test.ts`

```ts
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
    const notOk = (async () => ({ ok: false, json: async () => ({}) } as any)) as any;
    expect(await getModelIds(notOk)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/openrouter/catalog.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/openrouter/catalog.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/openrouter/catalog.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/openrouter/catalog.ts tests/openrouter/catalog.test.ts
git commit -m "feat(models): OpenRouter catalog module (cached, injectable fetch, tier derivation)"
```

---

### Task 2: Models page `<select>` (feature A)

Render model pickers as `<select>` from the catalog, with a free-text fallback when the catalog is unavailable.

**Files:**
- Modify: `src/web/routes/models.ts` (inject `getModels`, async select + fallback)
- Modify: `src/web/server.ts` (`WebDeps.getModels`, pass real default)
- Modify: `tests/web/home-route.test.ts` (its `GET /models` test must inject a fake `getModels` to avoid network)
- Test: `tests/web/models-select.test.ts` (create)

**Interfaces:**
- Consumes: `getModelIds` (Task 1), `layout`/`esc`/`Flash` (render).
- Produces: `registerModelsRoutes(app, db, getModels: () => Promise<string[]>)`; `WebDeps.getModels?: () => Promise<string[]>`.

- [ ] **Step 1: Write the failing test** — `tests/web/models-select.test.ts`

```ts
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { openDb, type DB } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { initCrypto } from '../../src/crypto/encryption.js';
import { startLogin, verifyCode } from '../../src/db/sessions.js';
import { setModels } from '../../src/db/config.js';
import { buildWebApp } from '../../src/web/server.js';

let db: DB, uid: number, cookie: string;
beforeAll(async () => {
  await sodium.ready;
  await initCrypto(sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
});
beforeEach(async () => {
  db = openDb(':memory:');
  uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 't', heartbeat_interval_min: 30 }).id;
  const { token, code } = startLogin(db, uid);
  verifyCode(db, token, code);
  cookie = `token=${token}`;
});

const IDS = ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5'];

describe('models <select>', () => {
  it('renders selects populated from the catalog with the current value selected', async () => {
    setModels(db, uid, { cheap_model: 'anthropic/claude-haiku-4.5', strong_model: 'anthropic/claude-sonnet-5' });
    const app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => IDS });
    const res = await app.inject({ method: 'GET', url: '/models', headers: { cookie } });
    expect(res.body).toContain('<select name="cheap_model">');
    expect(res.body).toContain('<option value="anthropic/claude-haiku-4.5" selected>');
  });

  it('keeps a stored value not in the catalog by prepending it, still selected', async () => {
    setModels(db, uid, { cheap_model: 'anthropic/deprecated-old', strong_model: 'anthropic/claude-sonnet-5' });
    const app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => IDS });
    const res = await app.inject({ method: 'GET', url: '/models', headers: { cookie } });
    expect(res.body).toContain('<option value="anthropic/deprecated-old" selected>');
  });

  it('falls back to free-text inputs when the catalog is empty', async () => {
    const app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => [] });
    const res = await app.inject({ method: 'GET', url: '/models', headers: { cookie } });
    expect(res.body).toContain('<input name="cheap_model"');
    expect(res.body).toContain("Couldn't load the model list");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/web/models-select.test.ts`
Expected: FAIL — `buildWebApp` has no `getModels`; route renders `<input>` not `<select>`.

- [ ] **Step 3: Update `src/web/routes/models.ts`**

Change `registerModelsRoutes` to accept `getModels` and render selects. Replace the whole file:

```ts
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import { getConfig, setModels, setOpenrouterKey, getOpenrouterKey } from '../../db/config.js';
import { layout, esc, type Flash } from '../render.js';

const SAVED_FLASH: Record<string, Flash> = {
  models: { kind: 'ok', msg: 'Models saved ✅' },
  key: { kind: 'ok', msg: 'OpenRouter key saved ✅' },
};

function modelField(name: string, label: string, current: string, ids: string[]): string {
  if (ids.length === 0) {
    return `<label>${label}<input name="${name}" value="${esc(current)}"></label>`;
  }
  const opts = ids.includes(current) ? ids : [current, ...ids];
  const options = opts
    .map((id) => `<option value="${esc(id)}"${id === current ? ' selected' : ''}>${esc(id)}</option>`)
    .join('');
  return `<label>${label}<select name="${name}">${options}</select></label>`;
}

export function registerModelsRoutes(
  app: FastifyInstance,
  db: DB,
  getModels: () => Promise<string[]>,
): void {
  app.get<{ Querystring: { saved?: string } }>('/models', async (req, reply) => {
    const userId = (req as any).userId as number;
    const cfg = getConfig(db, userId);
    const hasKey = !!getOpenrouterKey(db, userId);
    const flash = req.query.saved ? SAVED_FLASH[req.query.saved] : undefined;
    const ids = await getModels();
    const note =
      ids.length === 0
        ? `<p class="muted">Couldn't load the model list — enter a slug manually.</p>`
        : '';
    reply.type('text/html').send(
      layout(
        'Models',
        `<div class="card"><h2>Models</h2>${note}
        <form method="post" action="/models">
          ${modelField('cheap_model', 'Cheap model', cfg.cheap_model, ids)}
          ${modelField('strong_model', 'Strong model', cfg.strong_model, ids)}
          <button type="submit">Save models</button>
        </form></div>
        <div class="card"><h2>OpenRouter key</h2>
        <p class="muted">${hasKey ? 'Your key is set ✅' : 'No personal key yet — the instance key is used as a fallback.'}</p>
        <form method="post" action="/openrouter-key">
          <label>API key<input name="key" type="password" placeholder="sk-or-..."></label>
          <button type="submit">Save key</button>
        </form></div>`,
        { active: 'models', flash },
      ),
    );
  });

  app.post<{ Body: { cheap_model: string; strong_model: string } }>('/models', async (req, reply) => {
    const userId = (req as any).userId as number;
    setModels(db, userId, { cheap_model: req.body.cheap_model, strong_model: req.body.strong_model });
    reply.redirect('/models?saved=models');
  });

  app.post<{ Body: { key: string } }>('/openrouter-key', async (req, reply) => {
    const userId = (req as any).userId as number;
    if (req.body.key) setOpenrouterKey(db, userId, req.body.key);
    reply.redirect('/models?saved=key');
  });
}
```

- [ ] **Step 4: Update `src/web/server.ts`** — add `getModels` to `WebDeps`, default to the real catalog

Add the import:
```ts
import { getModelIds } from '../openrouter/catalog.js';
```
Add to the `WebDeps` interface:
```ts
  getModels?: () => Promise<string[]>;
```
Change the models registration line:
```ts
  registerModelsRoutes(app, deps.db, deps.getModels ?? getModelIds);
```

- [ ] **Step 5: Fix the existing `tests/web/home-route.test.ts`** — its `GET /models` test now needs a fake `getModels` (else it hits the network)

In `tests/web/home-route.test.ts`, change the `beforeEach` `buildWebApp` call to inject a fake:
```ts
  app = await buildWebApp({ db, appCfg: {} as any, getModels: async () => ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5'] });
```
(The dashboard `GET /` doesn't use `getModels`; the `GET /models` test in that file does.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/web/models-select.test.ts tests/web/home-route.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 7: Full suite**

Run: `npm test`
Expected: PASS. (`index.ts` needs no change — `buildWebApp` defaults `getModels` to the real `getModelIds`, so production uses the live catalog automatically.)

- [ ] **Step 8: Commit**

```bash
git add src/web/routes/models.ts src/web/server.ts tests/web/models-select.test.ts tests/web/home-route.test.ts
git commit -m "feat(ui): Models page uses live OpenRouter <select> with free-text fallback"
```

---

### Task 3: Config family + new-user default seeding (feature B)

Add `DEFAULT_MODEL_FAMILY` config and seed a new user's models from the catalog right after creation in `dispatch`, then wire it in `index.ts`.

**Files:**
- Modify: `src/config.ts` (add `defaultModelFamily`)
- Modify: `.env.example` (document the env)
- Modify: `src/agent/dispatch.ts` (inject `resolveDefaultModels`, seed after create)
- Modify: `src/index.ts` (wire the real `resolveDefaultModels`)
- Test: `tests/config.test.ts` (extend), `tests/agent/dispatch.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveDefaultModels` (Task 1), `setModels` (`db/config.js`).
- Produces: `AppConfig.defaultModelFamily: string`; `DispatchDeps.resolveDefaultModels?: () => Promise<{ cheap_model: string; strong_model: string } | undefined>`.

- [ ] **Step 1: Write the failing tests**

(a) In `tests/config.test.ts`, add cases for the new field:
```ts
it('defaults model family to anthropic/ and honors override', async () => {
  const { loadConfig } = await import('../src/config.js');
  const base = { DB_PATH: 'x', ENC_KEY: 'k', TELEGRAM_TOKEN: 't' };
  expect(loadConfig({ ...base } as any).defaultModelFamily).toBe('anthropic/');
  expect(loadConfig({ ...base, DEFAULT_MODEL_FAMILY: 'openai/' } as any).defaultModelFamily).toBe('openai/');
});
```

(b) In `tests/agent/dispatch.test.ts`, add a seeding describe block. Follow the file's existing harness for building `DispatchDeps` and a fake adapter; the key assertions:
```ts
import { getConfig } from '../../src/db/config.js';
// ... within the existing suite's setup that provides db + a deps factory + fake adapter:

it('seeds a new user’s models from resolveDefaultModels', async () => {
  const deps = makeDeps({
    resolveDefaultModels: async () => ({ cheap_model: 'anthropic/x-cheap', strong_model: 'anthropic/x-strong' }),
  });
  await handleInbound(deps, inbound('hello')); // new identity -> creates user, then seeds
  const uid = getUserByIdentity(db, 'telegram', 'newuser')!.id;
  expect(getConfig(db, uid).cheap_model).toBe('anthropic/x-cheap');
  expect(getConfig(db, uid).strong_model).toBe('anthropic/x-strong');
});

it('keeps SQL defaults when resolveDefaultModels returns undefined', async () => {
  const deps = makeDeps({ resolveDefaultModels: async () => undefined });
  await handleInbound(deps, inbound('hello'));
  const uid = getUserByIdentity(db, 'telegram', 'newuser')!.id;
  expect(getConfig(db, uid).cheap_model).toBe('anthropic/claude-haiku-4.5'); // schema default
});
```
Adapt `makeDeps`/`inbound`/user-not-allowlisted handling to the existing test file's helpers (a brand-new user is created before the allowlist gate returns, so `getConfig` is populated even though the reply is the NOT_AUTHORIZED message). If the existing tests allowlist via a helper, seed occurs regardless — it runs before the allowlist check.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/config.test.ts tests/agent/dispatch.test.ts`
Expected: FAIL — `defaultModelFamily` undefined; new user gets SQL defaults, not seeded values.

- [ ] **Step 3: Add `defaultModelFamily` to `src/config.ts`**

In the `AppConfig` interface add:
```ts
  defaultModelFamily: string;
```
In the returned object of `loadConfig` add:
```ts
    defaultModelFamily: env.DEFAULT_MODEL_FAMILY || 'anthropic/',
```

- [ ] **Step 4: Document in `.env.example`**

Append:
```
DEFAULT_MODEL_FAMILY=  # optional; provider prefix used to seed a new user's model defaults from the live OpenRouter catalog (default: anthropic/)
```

- [ ] **Step 5: Seed in `src/agent/dispatch.ts`**

Add `setModels` to the `db/users`… no — import from `db/config.js`:
```ts
import { setModels } from '../db/config.js';
```
Add to `DispatchDeps`:
```ts
  resolveDefaultModels?: () => Promise<{ cheap_model: string; strong_model: string } | undefined>;
```
In `handleInbound`, extend the new-user branch:
```ts
  if (!user) {
    user = createUserWithIdentity(db, {
      channel: m.channel,
      externalId: m.channelUserId,
      name: m.name,
      heartbeat_interval_min: deps.heartbeatDefaultMin,
    });
    const seeded = await deps.resolveDefaultModels?.();
    if (seeded) setModels(db, user.id, seeded);
  }
```

- [ ] **Step 6: Wire the real resolver in `src/index.ts`**

Add the import:
```ts
import { resolveDefaultModels } from './openrouter/catalog.js';
```
In the `handleInbound(...)` deps object (inside `adapter.onMessage`), add:
```ts
      resolveDefaultModels: () => resolveDefaultModels(appCfg.defaultModelFamily),
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts tests/agent/dispatch.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 8: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/config.ts .env.example src/agent/dispatch.ts src/index.ts tests/config.test.ts tests/agent/dispatch.test.ts
git commit -m "feat(models): seed new-user defaults from live catalog (DEFAULT_MODEL_FAMILY, SQL fallback)"
```

---

## Self-review notes (author)

- **Spec coverage:** catalog module + cache + tier rule (T1) ✓; `getModelIds` for dropdown (T1→T2) ✓; Models `<select>` + prepend-stored + empty fallback (T2) ✓; `DEFAULT_MODEL_FAMILY` config (T3) ✓; seed-after-create in dispatch (T3) ✓; index wiring for both (T2 needs none — server default; T3 step 6) ✓; tests all injected/no-network ✓.
- **No-network guarantee:** `buildWebApp` defaults `getModels` to real `getModelIds`, so tests that render `/models` MUST pass a fake — covered for the new test (T2 S1) and the pre-existing home-route test (T2 S5). No other test renders `/models`.
- **Type consistency:** `resolveDefaultModels` returns `{ cheap_model, strong_model } | undefined` in T1, consumed identically in T3; `getModels: () => Promise<string[]>` identical in models.ts + server.ts + tests.
- **Preserved:** softened OpenRouter-key copy kept verbatim in the rewritten models.ts.
- **No placeholders:** complete code in every code step (dispatch test adapts to the existing harness — the assertions and the seeded/undefined values are concrete).

## Manual check (after all tasks)

App runs in watch mode on :8080. Open `/models` while logged in → the two model fields are dropdowns of live OpenRouter models with your current values selected. (New-user seeding needs a fresh Telegram identity to observe; the dispatch tests cover it deterministically.)
