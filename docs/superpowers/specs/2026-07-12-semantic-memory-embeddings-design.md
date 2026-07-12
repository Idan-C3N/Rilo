# Semantic Memory Recall via Local Embeddings

**Date:** 2026-07-12
**Status:** Approved (brainstorm complete)
**Branch:** `feat/semantic-memory-embeddings` off `main`

## Goal

Make memory **recall** retrieve by *meaning*, not by exact substring. Today
`recall` is a `LIKE '%query%'` scan (`src/db/memory.ts`), so asking "what do I
know about the user's job hunt?" only matches memories containing those literal
words. With multilingual (Hebrew) content this misses obviously-relevant facts.

Scope is deliberately narrow: **retrieval only.** Write-time dedup/merge (e.g.
folding "Backslash Security" into the job-search list) is explicitly **out of
scope** for this change.

## Decisions (resolved in brainstorm)

- **Local embedding server in Docker**, internal-only, alongside the app — the
  "always there, like the database/searxng" model. No cloud API, no new secret.
- **Model:** `intfloat/multilingual-e5-small` (384-dim), strong Hebrew, ~0.5GB
  RAM — comfortable on the 4GB VPS beside app + searxng + caddy.
- **Server:** HuggingFace **Text Embeddings Inference** (TEI),
  `ghcr.io/huggingface/text-embeddings-inference:cpu-latest`. A named volume
  caches the model download.
- **Storage:** vectors live as a `BLOB` in the existing `memory` table. Per-user
  memory count is dozens, so brute-force cosine in JS is instant — **no vector
  DB, no `sqlite-vec`.**
- **Graceful degradation:** embed server down or a row not yet embedded → recall
  falls back to today's substring `LIKE`; writes never block on embedding.

## Architecture

### 1. `embed` container (`compose.yml`)

New service in the **base** `compose.yml` (runs locally and on the server):

```yaml
  embed:
    image: ghcr.io/huggingface/text-embeddings-inference:cpu-latest
    command: ["--model-id", "intfloat/multilingual-e5-small"]
    volumes:
      - embed_models:/data        # cache the model download across restarts
    restart: unless-stopped
```

- No host port (internal only, like `searxng`). App reaches it at `http://embed:80`.
- `compose.yml` injects into the `app` service (invariant, non-secret — same
  override pattern as `SEARXNG_URL`):
  - `EMBED_URL=http://embed:80`
  - `EMBED_MODEL=intfloat/multilingual-e5-small`
  - `EMBED_DIM=384`

### 2. Schema migration (`src/db/db.ts`, `src/db/schema.sql`)

Add a nullable column to `memory`:

```sql
embedding BLOB   -- Float32Array bytes; NULL = not embedded yet
```

- `schema.sql` gets the column for fresh DBs.
- `migrate()` adds it to existing DBs via a guarded `ALTER TABLE` — identical
  pattern to the existing `is_owner` guard (check `PRAGMA table_info(memory)`).

### 3. `src/agent/embeddings.ts` (new, injectable)

```ts
export type Embedder = (inputs: string[]) => Promise<number[][]>;

// Factory returns null-safe helpers around a TEI server.
export function makeEmbedder(baseUrl: string, fetchImpl?): Embedder
export function embedQuery(embed: Embedder, text: string): Promise<Float32Array | null>
export function embedPassages(embed: Embedder, texts: string[]): Promise<(Float32Array | null)[]>
```

- **e5 prefix rule (materially affects quality):** passages are embedded as
  `"passage: <text>"`, queries as `"query: <text>"`. These helpers own the
  prefixing so callers never forget it.
- POSTs to TEI (`POST ${baseUrl}/embed`, body `{ inputs: [...] }`, returns
  `number[][]`). Normalize `baseUrl` (strip trailing `/`).
- **Never throws into the user path:** any network/HTTP error → returns `null`
  (or an array of `null`s). Injectable `fetchImpl` so tests supply a fake
  embedder with deterministic vectors (mirrors the web-search `SearchFn` pattern).
- Vectors stored/compared as `Float32Array`; BLOB (de)serialization helpers live
  here or in `memory.ts` (`vectorToBlob` / `blobToVector`).

### 4. `src/db/memory.ts` changes

Signatures gain an optional injected `Embedder` so the DB layer stays testable.

- **`remember(db, userId, text, mkey?, embed?)`**: insert the row as today, then
  **best-effort** compute the passage embedding and `UPDATE memory SET embedding
  = ?`. On `null`/failure the row keeps `embedding = NULL` (backfilled later).
  The insert always succeeds regardless of the embed server.
- **`recallSemantic(db, userId, query, embed, k = 8, threshold = 0.80)`**:
  - No `query` → recent list (today's behavior, unchanged).
  - With `query`: `embedQuery` → load the user's rows that have vectors →
    cosine similarity → return the top-`k` texts scoring ≥ `threshold`.
  - **Threshold note:** e5 cosine scores are compressed (relevant pairs ~0.80+,
    unrelated ~0.70+), so `0.80` is a conservative starting floor to be tuned
    against the real memories during implementation. `k` caps how many reach the
    LLM regardless.
  - `embedQuery` returns `null` (server down) **or** the user has zero embedded
    rows → **fall back to the existing substring `LIKE`** path.
- **`backfillEmbeddings(db, embed, limit)`**: embed rows where `embedding IS
  NULL` in bounded batches. Runs once at boot (re-embeds the existing 5
  memories and any saved while the server was down). Best-effort; failures leave
  rows NULL for the next boot.
- `cosine(a, b)` helper (both are unit-normalizable 384-vectors).

### 5. Wiring (`src/agent/tools/index.ts`, `src/agent/tools/memory.ts`, `src/config.ts`, `src/index.ts`)

- `config.ts` reads `EMBED_URL` (+ model/dim); when set, `index.ts` builds an
  `Embedder` and threads it into the memory tools + a boot-time `backfillEmbeddings`.
- `makeRememberTool` / `makeRecallTool` pass the `Embedder` through to
  `remember` / `recallSemantic`.
- `EMBED_URL` unset (e.g. native `npm run dev`) → no embedder → `remember`
  skips vectors, `recall` uses substring. Fully functional, just non-semantic.

## Data flow

- **save:** insert row → `embedPassages(["passage: text"])` → `UPDATE embedding` (best-effort)
- **recall(query):** `embedQuery("query: q")` → cosine over user's vectors → top-k texts; else substring fallback
- **boot:** `backfillEmbeddings` re-embeds rows where `embedding IS NULL`

## Error handling

Embeddings are strictly an enhancement; the memory feature must work with the
embed server absent or failing:

- Embed server unreachable on **write** → row saved with `NULL` vector; boot
  backfill fills it later.
- Embed server unreachable on **recall** → substring `LIKE` (today's behavior).
- User has no embedded rows yet → substring `LIKE`.
- Corrupt/wrong-dimension BLOB → skipped in the cosine scan (defensive length check).

## Testing (TDD)

- `embeddings.ts`: injected fake `fetchImpl` — prefix correctness (`query:` /
  `passage:`), `null` on HTTP error, BLOB round-trip.
- `memory.ts`: injected fake `Embedder` returning fixed vectors — cosine ranking
  order, top-`k`, threshold cutoff, substring fallback when embedder returns
  `null`, `remember` succeeds when embedder fails, `backfillEmbeddings` only
  touches NULL rows.
- `db.ts`: migration adds `embedding` to a pre-existing memory table (no data loss).

## Deployment

`embed` is in the base `compose.yml`, so the existing public redeploy picks it
up unchanged:

```bash
cd /opt/personal-agent && git pull
docker compose -f compose.yml -f compose.caddy.yml up -d --build
```

First boot pulls the TEI image + downloads the model into the `embed_models`
volume (one-time). RAM budget after: ~1GB of 4GB.

## Out of scope

- Write-time dedup/merge/consolidation of related memories.
- A separate vector database or `sqlite-vec`.
- Cloud embedding APIs.
- Re-ranking, hybrid keyword+vector scoring beyond the substring fallback.
