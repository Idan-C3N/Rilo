# Web Search Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pluggable web-search backends — bundled SearXNG (default), opt-in Google Custom Search, Tavily demoted to explicit `SEARCH_BACKEND=tavily` — with a `selectSearchBackend` precedence helper wired into config, index, deploy, and `.env.example`.

**Architecture:** The web-search tool already abstracts its backend behind an injectable `SearchFn`. Add two new `SearchFn` factories (`searxngSearch`, `googleSearch`) next to `tavilySearch`, plus a pure `selectSearchBackend(cfg)` selector that picks a backend by env precedence. `index.ts` passes the selected `SearchFn` into `buildToolsFor` via the existing `search?` option.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, global `fetch`, Docker Compose, SearXNG.

## Global Constraints

- Touch ONLY: `src/agent/tools/websearch.ts`, `src/index.ts`, `src/config.ts`, `.env.example`, `deploy/` (compose + searxng settings), `tests/agent/tools/websearch.test.ts`. Do NOT edit `src/web/server.ts` or `src/agent/dispatch.ts`.
- No new runtime dependencies. Use global `fetch` (Node 22+).
- Tests inject a fake `fetch`; no real network calls.
- `searxngUrl` default = `http://searxng:8080`.
- Error message style mirrors Tavily: `"<Backend> search failed: <status> <body>"`.
- Verify with `npm test` and `npm run typecheck` (no `build` script exists).

---

### Task 1: `googleSearch` and `searxngSearch` backends + `selectSearchBackend`

**Files:**
- Modify: `src/agent/tools/websearch.ts`
- Test: `tests/agent/tools/websearch.test.ts`
- Modify: `src/config.ts` (config fields the selector consumes)

**Interfaces:**
- Consumes: `SearchFn`, `SearchResult` (existing in websearch.ts); `AppConfig` (config.ts).
- Produces:
  - `searxngSearch(baseUrl: string): SearchFn`
  - `googleSearch(apiKey: string, cx: string): SearchFn`
  - `selectSearchBackend(cfg: SearchBackendConfig): SearchFn | undefined` where
    `SearchBackendConfig = { searchBackend?: string; searxngUrl?: string; googleSearchKey?: string; googleSearchCx?: string; tavilyApiKey?: string }`
  - Config fields: `searxngUrl` (default `http://searxng:8080`), `googleSearchKey?`, `googleSearchCx?`, `searchBackend?`.

- [ ] **Step 1: Add config fields** — add `searxngUrl`, `googleSearchKey`, `googleSearchCx`, `searchBackend` to `AppConfig` and `loadConfig`.

- [ ] **Step 2: Write failing tests** for `googleSearch`, `searxngSearch`, `selectSearchBackend` (fake fetch, table test). Run `npm test` → FAIL (functions not exported).

- [ ] **Step 3: Implement** `searxngSearch`, `googleSearch`, `selectSearchBackend` in websearch.ts.

- [ ] **Step 4: Run tests** → PASS. Run `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**

### Task 2: Wire selector into `index.ts`

**Files:** Modify `src/index.ts`.

- Replace `webSearchKey: appCfg.tavilyApiKey` with `search: selectSearchBackend(appCfg)` in the `buildToolsFor` call; import `selectSearchBackend`.
- Run `npm run typecheck` → clean. Commit.

### Task 3: Deploy compose + SearXNG settings + `.env.example`

**Files:** Modify `deploy/docker/compose.yml`; create `deploy/docker/searxng/settings.yml`; modify `.env.example`.

- Add `searxng` service (image `searxng/searxng`), internal `8080`, mount settings, app `depends_on: [searxng]` + `SEARXNG_URL=http://searxng:8080`.
- `settings.yml`: enable `formats: [html, json]` + a `secret_key`.
- `.env.example`: add the documented web-search block.
- Commit.
