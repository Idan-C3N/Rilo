# Web Search Backends: SearXNG (bundled default) + Google, Tavily demoted

**Date:** 2026-07-11
**Issue:** #8 — Tavily → pluggable search backends
**Status:** Approved (brainstorm complete)
**Agent branch:** own branch off `main`, merge back when self-review passes
**Isolation:** high — does not touch `web/server.ts` or `agent/dispatch.ts`; safe to run in parallel with #1

## Goal

Make web search work out of the box for anyone who clones the OSS repo, with **no signup and no cost**, while letting an operator opt into Google Custom Search via env, and preserving Tavily for comparison. Reduce the "services a stranger must register" to **zero** for the default path.

## Decisions (resolved in brainstorm)

- **SearXNG is the always-on default.** It is bundled into the `deploy/` Docker compose so it boots with the app — the "always there, like the database" model. No API key, no signup, no per-query cost.
- **Google Custom Search** is an opt-in backend: if `GOOGLE_SEARCH_KEY` + `GOOGLE_SEARCH_CX` are set, it is used instead of SearXNG. (Free tier ~100 queries/day.)
- **Tavily is kept but demoted.** It stays in the codebase (operator currently uses it and wants to A/B it) but is reachable **only** via an explicit `SEARCH_BACKEND=tavily`. It is not in the automatic precedence.
- **`SEARCH_BACKEND` override** exists to force a specific backend for A/B comparison without unsetting other env.

## Architecture

The tool already abstracts the backend behind an injectable `SearchFn` in
`src/agent/tools/websearch.ts`:

```ts
export type SearchFn = (query: string, maxResults: number) => Promise<SearchResult[]>;
export interface SearchResult { title: string; url: string; content: string; }
```

We add two more `SearchFn` factories next to the existing `tavilySearch`, and move
the "which backend" decision into a single selector used by `index.ts`.

### New backends (`src/agent/tools/websearch.ts`)

**`searxngSearch(baseUrl: string): SearchFn`**
- Calls `GET ${baseUrl}/search?q=<query>&format=json` (URL-encode `q`).
- Maps `data.results[]` → `{ title, url, content }` where `content` = result `content` (SearXNG's snippet field). Take the first `maxResults` results.
- Throws `Error("SearXNG search failed: <status> <body>")` on non-OK (mirrors the Tavily error style). No trailing slash assumptions — normalize `baseUrl` (strip one trailing `/`).

**`googleSearch(apiKey: string, cx: string): SearchFn`**
- Calls `GET https://www.googleapis.com/customsearch/v1?key=<key>&cx=<cx>&q=<query>&num=<n>` where `num = min(maxResults, 10)` (Google caps `num` at 10).
- Maps `data.items[]` → `{ title: item.title, url: item.link, content: item.snippet }`, missing fields → `''`.
- Throws `Error("Google search failed: <status> <body>")` on non-OK.

`tavilySearch` and `makeWebSearchTool` are unchanged.

### Selector (`src/index.ts`)

Add a small pure helper (co-located in `websearch.ts` so it is unit-testable, e.g.
`selectSearchBackend(cfg): SearchFn | undefined`). Precedence:

1. If `SEARCH_BACKEND` is set, use exactly that backend:
   - `searxng` → `searxngSearch(cfg.searxngUrl)` (requires `searxngUrl`)
   - `google` → `googleSearch(cfg.googleSearchKey, cfg.googleSearchCx)` (requires both)
   - `tavily` → `tavilySearch(cfg.tavilyApiKey)` (requires key)
   - If the named backend's required config is missing → throw a clear config error at startup (fail fast, don't silently fall through).
2. Else if `googleSearchKey` **and** `googleSearchCx` are set → Google.
3. Else → SearXNG using `searxngUrl` (default when unset — see config).

The selector returns a `SearchFn`. It is passed into `buildToolsFor` via the existing
`search?: SearchFn` option (which already takes precedence over `webSearchKey`). The
old `webSearchKey: appCfg.tavilyApiKey` wiring in `index.ts:37` is **replaced** by
`search: selectSearchBackend(appCfg)`.

`buildToolsFor` (`src/agent/tools/index.ts`) already offers the web-search tool only
when a `SearchFn` is present, and `makeWebSearchTool` already wraps `execute` in
try/catch returning `{ error }` — so a down SearXNG degrades gracefully (the model
sees a search error, not a crash). No change needed there beyond what the selector feeds it.

## Config (`src/config.ts`)

Add to `AppConfig` and `loadConfig`:

| Field | Env | Default | Notes |
|---|---|---|---|
| `searxngUrl` | `SEARXNG_URL` | `http://searxng:8080` | compose service name; default so SearXNG "just works" in Docker |
| `googleSearchKey` | `GOOGLE_SEARCH_KEY` | undefined | distinct from `GOOGLE_CLIENT_ID` (that's OAuth, #1) |
| `googleSearchCx` | `GOOGLE_SEARCH_CX` | undefined | Programmable Search Engine id |
| `searchBackend` | `SEARCH_BACKEND` | undefined | `searxng` \| `google` \| `tavily` |

Keep `tavilyApiKey` / `TAVILY_API_KEY` as-is.

> **Default note:** `searxngUrl` defaults to `http://searxng:8080` so the Docker path
> needs no env at all. A bare `node` run without SearXNG will get search errors from
> the tool (handled) unless the operator points `SEARXNG_URL` elsewhere or sets Google
> keys. This is the accepted trade-off — Docker is the documented deploy path.

## Deploy (`deploy/`)

- Add a `searxng` service to the Docker compose (image `searxng/searxng`), on the same
  network as the app, exposing `8080` internally (no host publish needed).
- Provide a minimal `searxng/settings.yml` enabling the **JSON** format
  (`search.formats: [html, json]`) and a generated `secret_key`. Bind-mount or bake it in.
- App service gets `SEARXNG_URL=http://searxng:8080` (matches the config default; explicit
  in compose for clarity) and `depends_on: [searxng]`.
- Document nothing operator-specific here — README/quickstart copy is deferred to #5.

## `.env.example`

Add, with comments, in an order that teaches the precedence:

```
# --- Web search backend ---
# Default: bundled SearXNG (no signup, no cost). Docker compose wires this automatically.
SEARXNG_URL=http://searxng:8080
# Opt in to Google Programmable Search instead (set BOTH):
# GOOGLE_SEARCH_KEY=
# GOOGLE_SEARCH_CX=
# Force a specific backend for comparison (searxng|google|tavily); overrides the above:
# SEARCH_BACKEND=
# Tavily is demoted — reachable only via SEARCH_BACKEND=tavily:
# TAVILY_API_KEY=
```

## Testing

Mirror `tests/agent/tools/websearch.test.ts` (inject a fake `fetch`):

- **`googleSearch`**: fake fetch returns a canned `{ items: [...] }`; assert URL contains
  `key`, `cx`, `q`, `num`; assert mapping `link→url`, `snippet→content`; assert `num`
  clamps to 10 when `maxResults > 10`; assert throw on non-OK.
- **`searxngSearch`**: fake fetch returns `{ results: [...] }`; assert URL is
  `${base}/search?q=...&format=json`; assert mapping and `maxResults` slice; assert
  trailing-slash normalization; assert throw on non-OK.
- **`selectSearchBackend`** (pure, no fetch): table test over env combos →
  asserts which factory is chosen, and that `SEARCH_BACKEND=google` with missing
  `cx` throws a clear error.

## Files touched

- `src/agent/tools/websearch.ts` — add `searxngSearch`, `googleSearch`, `selectSearchBackend`
- `src/index.ts` — replace `webSearchKey` wiring with `search: selectSearchBackend(appCfg)`
- `src/config.ts` — new fields
- `.env.example` — new block
- `deploy/` — compose `searxng` service + `settings.yml`
- `tests/agent/tools/websearch.test.ts` — new cases (or a sibling test file)

## Out of scope

- README / user-facing search docs → **#5**.
- Removing Tavily entirely → explicitly rejected (kept, demoted).
- Result re-ranking / content fetching / caching.

## Verification (Definition of Done)

- `npm test` green (new backend + selector tests included).
- `npm run build` / typecheck clean.
- With no search env set, in the Docker compose, the `web_search` tool returns real
  results via SearXNG.
- Setting `GOOGLE_SEARCH_KEY`+`GOOGLE_SEARCH_CX` switches to Google;
  `SEARCH_BACKEND=tavily` switches to Tavily.
