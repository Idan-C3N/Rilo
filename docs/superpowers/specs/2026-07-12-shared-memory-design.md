# Shared Memory Between People (Household / Group Spaces) — Design

**Date:** 2026-07-12
**Backlog:** #12
**Status:** Approved (brainstorm complete)

## Goal

Let two or more allowlisted users share a common memory space so the agent has
shared context across them — e.g. Idan + wife sharing household facts ("kids'
school pickup is 15:30", "our anniversary is Feb 14", the shopping list) without
each having to re-teach the bot. A user creates a named space, adds another
allowlisted user, and facts can be written into the shared space either
explicitly or via a model-suggested, writer-confirmed flow.

## Scope

**In scope:** shared **durable facts** — the `memory` layer (`remember`/`recall`).
Shared "lists" (shopping list, trip items) fall out for free since they are just
memory rows.

**Explicitly deferred (own specs later):**

- **Shared reminders** — "ping *both* of us at 15:30". Different table (`jobs`),
  raises whose-device / whose-quiet-hours questions. Separate feature.
- **Shared heartbeat** — a proactive brain that nudges the household as a unit
  (vs each member's own heartbeat). Thorniest; separate feature.

Note the distinction from §5: each member's *personal* heartbeat **will** read
shared facts as input (in scope). What is deferred is a *single shared heartbeat
actor*.

## Current State (verified against HEAD)

- Memory is the SQLite `memory` table (`schema.sql:59`), keyed by `user_id`, with
  a nullable `embedding BLOB` column. Semantic recall stores a 384-d vector per
  row and computes cosine similarity **in application code, row by row**
  (`db/memory.ts` `recallVector`) — there is no separate vector database.
- Every read/write filters `WHERE user_id = ?` (`db/memory.ts`).
- Memory tools are built per-user in `agent/tools/index.ts` (`remember`, `recall`).
- The heartbeat proactive brain reads the caller's facts via `recall`
  (`scheduler/heartbeat.ts:32`) to decide whether to nudge.
- Migrations use idempotent, presence-guarded `ALTER`/`CREATE` in `db/db.ts`
  `migrate()` — new columns and tables apply cleanly to an existing DB on boot.
- There is no concept of a group anywhere.

## Decisions (resolved in brainstorm)

1. **Grouping model:** named multi-space groups. A user creates/names a space and
   adds members. (Not: one implicit household; not pairwise.)
2. **Sharing target:** shared facts on the `memory` table only (see Scope).
3. **Write consent:** **writer-only.** The author confirms; the other member does
   not approve incoming facts. No per-member pending-approval queue.
4. **Membership / invite:** the creator **adds an existing allowlisted user
   directly** (no invite-code, no accept step). Both users are already past the
   #9 onboarding allowlist gate, so mutual trust is assumed. No "you were added"
   notice in v1.
5. **Delete / edit rights:** **any member** can edit or delete any shared fact in
   a space they belong to. Flat and symmetric.
6. **Attribution:** stored but not enforced. `memory.user_id` is the author of a
   shared row; the UI shows "added by X". Used for display and to let the model
   phrase recall ("you told me…" vs "your wife noted…").
7. **Default scope:** **personal.** A memory is personal unless explicitly written
   to a space or the writer confirms a model suggestion to share.
8. **Heartbeat input:** each member's personal heartbeat reads personal **+**
   shared facts, firing on that member's own schedule/quiet-hours.

## Data Model

Additive. Two new tables + one new nullable column, all applied via the existing
guarded-migration pattern in `db/db.ts`.

```sql
CREATE TABLE IF NOT EXISTS spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS space_members (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members(user_id);

-- memory gains a nullable space_id.
--   space_id NULL  -> personal fact, owned by user_id
--   space_id set   -> shared fact in that space, authored by user_id
ALTER TABLE memory ADD COLUMN space_id INTEGER REFERENCES spaces(id);
CREATE INDEX IF NOT EXISTS idx_memory_space ON memory(space_id);
```

**Row rule:** a memory row is **personal** (`space_id IS NULL`, belongs to
`user_id`) or **shared** (`space_id` set, authored by `user_id`, owned by the
space). One fact belongs to exactly one scope — a fact is never in two spaces and
never both personal and shared. `user_id` doubles as attribution; no separate
`created_by` column on `memory`.

Migration for existing DBs: `schema.sql` adds the two `CREATE TABLE IF NOT
EXISTS`; `db/db.ts` `migrate()` gets a guarded `ALTER TABLE memory ADD COLUMN
space_id` (presence-checked like the existing `embedding` migration). Existing
memory rows have `space_id NULL` → all remain personal. Zero-touch on boot.

## Components

### `db/spaces.ts` (new)

Membership + space CRUD, mirroring the style of `db/users.ts`.

- `createSpace(db, { name, createdBy }): Space` — inserts the space and adds the
  creator as the first member.
- `addMember(db, spaceId, userId)` / `removeMember(db, spaceId, userId)`.
- `isMember(db, spaceId, userId): boolean`.
- `listSpacesForUser(db, userId): Space[]`.
- `listMembers(db, spaceId): User[]`.
- `getSpaceByName(db, userId, name): Space | undefined` — resolve a chat-supplied
  name to a space the user belongs to (names are not globally unique; scoped to
  the caller's memberships).

### `db/memory.ts` (scope-aware)

- `remember(db, userId, text, opts?: { mkey?; spaceId? }): number` — when
  `spaceId` is set, the caller **must** be a member (enforced by the caller in the
  tool layer, re-checked here defensively). `user_id` = author.
- `recall` / `recallVector` — widen the row set to personal + shared:

  ```sql
  SELECT * FROM memory
  WHERE (space_id IS NULL AND user_id = ?)
     OR space_id IN (SELECT space_id FROM space_members WHERE user_id = ?)
  ```

  The cosine similarity loop in `recallVector` runs over this merged set
  unchanged. `recall` (substring / recent-list fallback) uses the same predicate.
- `forget(db, id)` — deletion by row id already exists; the **rights check**
  (any member may delete a shared row; author or owner may delete a personal row)
  lives in the tool / route layer, not in this low-level helper.
- A helper to expose scope + author on returned rows for the UI and for the
  model's phrasing (e.g. `MemoryItem` gains `space_id`).

### `agent/tools/memory.ts` (consent-aware)

- `remember` tool gains an optional `space` argument (space name). Tool
  description instructs the model: **default to personal**; when a fact is
  clearly relevant to a shared space the user belongs to, **ask before sharing**
  and only pass `space` after the user confirms in-chat. An explicit user request
  ("remember for Home: …") writes directly with `space` set, no extra ask.
- On a `space` write the tool resolves the name via `getSpaceByName`, verifies
  membership, then calls `remember(..., { spaceId })`. Unknown/unauthorized space
  → tool returns a clear error the model can relay.
- `recall` tool is unchanged at the call site — the widened DB query merges shared
  facts automatically. Returned items carry scope + author so the model can
  attribute.

### `agent/tools/spaces.ts` (new tool)

A single `spaces` tool (or a small set) letting the model manage spaces from chat:
create a space, add an allowlisted member (by name), list the caller's spaces and
members, leave a space. Membership operations are gated to allowlisted users.

### `agent/tools/index.ts`

Register the new `spaces` tool and pass through the embedder to `remember` as
today.

### `scheduler/heartbeat.ts`

`decideHeartbeat` recall (line 32) uses the widened recall so shared facts feed
the proactive gate. No change to scheduling, quiet-hours, or per-user firing.

### `web/` (Spaces UI)

New route + page (`web/routes/spaces.ts`, styled like existing routes, htmx
progressive-enhancement consistent with #10):

- Create / name a space.
- Add a member from the allowlisted-user list; remove a member; leave.
- View shared facts in a space with "added by X"; delete a shared fact (any
  member).

## Data Flow

**Write (explicit):** user → dispatch → LLM calls `remember({ text, space:'Home' })`
→ tool resolves + membership-checks `Home` → `remember(db, userId, text,
{ spaceId })` → embed-on-write (unchanged) → row visible to all members.

**Write (model-suggested):** user says something household-relevant → model asks
"Save to Home?" → user confirms next turn → same path as explicit.

**Read:** any member → `recall`/`recallVector` merged query → personal + shared
rows ranked together by cosine → model answers, attributing shared rows.

**Heartbeat:** per-user timer fires → `decideHeartbeat` reads merged facts →
may nudge that member about a shared fact, on their own schedule.

## Error Handling

- Writing to a space the user is not a member of → tool returns an explicit error;
  no row written.
- Resolving an unknown space name → tool returns "no space named X"; model relays.
- Membership/space DB failures are surfaced, not swallowed (consistent with the
  structured-logging turn error path).
- Embedding failures on a shared write degrade exactly as today (best-effort embed;
  substring fallback on recall).

## Privacy Boundary

The core guarantee: **a personal fact never appears in another user's recall.**
Enforced by the SQL predicate — `space_id IS NULL AND user_id = ?` only matches
the caller's own personal rows; shared rows require `space_id` to be in the
caller's memberships. There is no code path that returns another user's personal
rows. This is asserted directly in tests.

## Testing

- **Scope isolation:** user A's personal fact is invisible to user B's recall
  (both substring and vector paths).
- **Shared read/write:** A writes to a space; B (member) recalls it; a non-member
  C does not.
- **Membership gate:** writing to a space you are not in is rejected.
- **Delete rights:** any member can delete a shared fact; the row is gone for all.
- **Attribution:** a shared row reports its author.
- **Migration:** opening a pre-#12 DB adds `space_id` (NULL) and the new tables;
  existing rows remain personal and recall unchanged.
- **Heartbeat input:** `decideHeartbeat` sees shared facts for a member of a space.
- **Tool consent:** explicit "remember for Home" writes shared; a plain personal
  statement stays personal (prompt-level behavior — assert the tool passes
  `spaceId` only when `space` is provided).

## File Impact

| File | Change |
|---|---|
| `db/schema.sql` | + `spaces`, `space_members`, `memory.space_id` column + indexes |
| `db/db.ts` | guarded `ALTER TABLE memory ADD COLUMN space_id` in `migrate()` |
| `db/spaces.ts` | **new** — space + membership CRUD |
| `db/memory.ts` | scope-aware `remember`, widened `recall`/`recallVector`, scope on `MemoryItem` |
| `agent/tools/memory.ts` | `remember` gains `space` arg + consent instructions |
| `agent/tools/spaces.ts` | **new** — manage spaces from chat |
| `agent/tools/index.ts` | register `spaces` tool |
| `scheduler/heartbeat.ts` | widened recall (shared facts as heartbeat input) |
| `web/routes/spaces.ts` | **new** — Spaces management page |
| `web/server.ts` | mount the Spaces route |

## Out of Scope / Future

- Shared reminders (ping both members) — separate spec.
- Shared heartbeat actor (nudge the household as a unit) — separate spec.
- Invite codes / accept-to-join, "you were added" notifications, recipient-side
  write approval — deliberately rejected for v1; revisit only if a lower-trust
  multi-user scenario emerges.
- Per-fact multi-space membership — a fact stays single-scope.
