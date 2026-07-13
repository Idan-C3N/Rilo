# Space Invite Codes — Design

**Date:** 2026-07-13
**Backlog:** #12 follow-up (privacy/authorization); relates to #3 security
**Status:** Approved (brainstorm complete)

## Goal

Replace the roster-enumerating "add member" flow for shared spaces with
consent-based, single-use invite codes. Today any allowlisted user who opens the
web `/spaces` page sees a `<datalist>` of **every** allowlisted user's name — a
privacy leak for non-owners. Invite codes remove all user enumeration: a space
member generates a short code, sends it to the invitee out-of-band, and the
invitee redeems it to join. Nobody browses a list of who uses the app.

## Scope

**In scope:** a `space_invites` table; generate + redeem via the bot and the web
UI; removal of the enumerating add-member surfaces (web datalist + the `spaces`
tool's `add_member` action).

**Explicitly out of scope:**

- **App access via invite** — redeeming only adds an **already-allowlisted** user
  to a space. It does NOT onboard/allowlist a new app user (that stays with #9
  registration + owner approval). (Brainstorm option B, declined.)
- **Redeem rate-limiting** — noted as a belt-and-suspenders item for the #3
  security pass; not required here (see Security).
- **Multi-use / N-use codes** — single-use only.

## Decisions (from brainstorm)

1. **Space-only:** invite adds an already-allowlisted user to a space; never
   grants app access.
2. **Single-use + 7-day TTL:** a code dies on first redemption OR after 7 days,
   whichever comes first.
3. **Any space member may generate** an invite to a space they belong to.
4. **Both surfaces:** generate + redeem from the bot AND the web UI.
5. **Short, human-friendly code:** ~6 chars, uppercase, unambiguous alphabet — it
   is typed by a human in chat, unlike the long login/registration token.
6. **Auto-generate one code on space creation** (for discoverability — a user who
   didn't get a code at creation has no cue that inviting means "generate a
   code"). Members can generate additional codes anytime. Both surfaces keep the
   invite affordance visible: the bot presents the code + offers more on create;
   the web space card always shows active codes + a "Generate another" button.

## Current State (verified against HEAD)

- Spaces exist: `spaces`, `space_members` tables; `createSpace`, `addMember`,
  `removeMember`, `isMember`, `listMembers`, `listSpacesForUser`, `getSpaceByName`
  (`src/db/spaces.ts`).
- **The leak:** `src/web/routes/spaces.ts` builds an "Add member" `<datalist>`
  from `listAllowlisted(db)` (lines ~17, ~33, ~40-41) — every allowlisted user's
  name, rendered for any logged-in member. The POST `/spaces/:id/members` route
  resolves the typed name against `listAllowlisted` (line ~66).
- The bot `spaces` tool (`src/agent/tools/spaces.ts`) exposes `add_member`, which
  also matches a typed name against `listAllowlisted` (adds by name, no invitee
  consent). It does not *return* the list, so it does not itself enumerate, but it
  is the by-name add path we are replacing.
- Users are keyed by `(channel, external_id)` in `identities`, NOT by phone. Phone
  is captured only transiently in `pending_registrations` at signup
  (`schema.sql:~115`) — so "add by phone" is not a free identifier; invite codes
  avoid needing one.
- Allowlist gating: `isAllowlisted(db, userId)` (`src/db/users.ts`).
- Precedent for one-time, expiring tokens: `sessions` (magic-link) and
  `pending_registrations` — random token + `expires_at`, validated then consumed.
  Migrations are idempotent `ALTER`/`CREATE TABLE IF NOT EXISTS`
  (`src/db/db.ts` `migrate`, `schema.sql`).

## Architecture

### 1. Data model — `space_invites` (new table)

```sql
CREATE TABLE IF NOT EXISTS space_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_by INTEGER REFERENCES users(id),   -- NULL until redeemed
  redeemed_at INTEGER                          -- NULL until redeemed
);
CREATE INDEX IF NOT EXISTS idx_space_invites_code ON space_invites(code);
```

Fresh DBs get this from `schema.sql`; existing DBs need no `ALTER` (it's a new
table, created by `CREATE TABLE IF NOT EXISTS` in the schema exec). **A valid
invite** is `redeemed_at IS NULL AND expires_at > now`.

**Code generation:** 6 characters drawn from an unambiguous uppercase alphabet
`ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `O/0/I/1/L`), from a CSPRNG
(`node:crypto`). On the astronomically-unlikely `UNIQUE` collision, regenerate.

### 2. DB layer — `src/db/spaceInvites.ts` (new)

- `createInvite(db, { spaceId, createdBy, ttlMs = 7*24*60*60*1000 }): { code }` —
  generate a unique code, insert, return it.
- `getValidInvite(db, code): SpaceInvite | undefined` — the row iff
  `redeemed_at IS NULL AND expires_at > Date.now()`.
- `redeemInvite(db, code, userId): { ok, spaceId? , error? }` — in a transaction:
  re-check validity, `addMember(db, spaceId, userId)`, set
  `redeemed_by = userId, redeemed_at = now`. Idempotent-safe: a second redeem of
  the same code fails (already redeemed).
- `listActiveInvites(db, spaceId): SpaceInvite[]` — `redeemed_at IS NULL AND
  expires_at > now`, for the web card display.

Space creation auto-mints the first code: the `create` bot action and the
`POST /spaces` web route call `createInvite` right after `createSpace`.

### 3. Bot tool — replace `add_member` in `src/agent/tools/spaces.ts`

Drop the `add_member` action (and its `listAllowlisted` use). Add two actions (or
two small tools — implementation detail for the plan):

- `invite` — `{ space }` → member-gated (`isMember`); returns the code. The agent
  presents it for the user to forward.
- `redeem` — `{ code }` → caller must be allowlisted (they are, to be chatting);
  redeem → join. Returns the space joined or an error (invalid/expired/used).

Keep `list`, `leave` unchanged. `create` now **also mints an invite code** (calls
`createInvite`) and returns it alongside the new space, so the agent presents it
immediately (persona: confirm + offer next step). The tool no longer references
`listAllowlisted`, so the bot can no longer add or reveal users by name.

### 4. Web — `src/web/routes/spaces.ts`

- **Remove** the add-member `<datalist>` + its `listAllowlisted` enumeration and
  the by-name POST `/spaces/:id/members` handler.
- **Add** per space card (members only): the card lists any **active** invite
  codes for that space (unredeemed + unexpired) with their expiry, plus a
  "Generate another" button → `POST /spaces/:id/invite` → creates a code and
  re-renders the card. Creating a space (`POST /spaces`) also mints the first code
  so a fresh card is never empty of an invite affordance.
- **Add** a "Redeem invite code" input (page-level) → `POST /spaces/redeem` with
  the code → joins → redirect. Follows the existing form-POST + redirect pattern
  (not htmx), matching the rest of `spaces.ts`.
- Ownership/membership gates: generate requires `isMember`; redeem requires the
  session user (already allowlisted via the web auth preHandler).

### 5. Security

Single-use + 7-day TTL + generation gated to space members + redemption gated to
allowlisted users. The code is **not** a sole auth factor (unlike the login
token): it does nothing without an allowlisted account, so a short 6-char code is
acceptable. No surface enumerates users. Redeem rate-limiting is deferred to the
#3 security pass (noted, not required — the double gate bounds the brute-force
surface to already-trusted insiders).

## Error Handling

- Redeem of an invalid / expired / already-redeemed code → `{ ok: false, error }`;
  no membership change.
- Generate by a non-member → refused.
- `UNIQUE(code)` collision on generate → regenerate (bounded retry).
- Redeem by a user already in the space → treat as success (idempotent join) but
  still consume the code (single-use).

## Testing

- **`spaceInvites` db:** create returns a valid code; `getValidInvite` honors
  expiry + redeemed; `redeemInvite` adds the member and marks the row; a second
  redeem fails; an expired code fails; `listActiveInvites` excludes redeemed +
  expired.
- **bot tool:** `create` returns a space **and** a code; `invite` refused for a
  non-member; `redeem` joins on a valid code and rejects invalid/expired/used;
  `list`/`leave` unchanged; the tool no longer exposes `add_member`.
- **web:** creating a space yields a card showing one active code; "Generate
  another" adds a code for a member; redeem joins; a non-member cannot generate;
  **a regression test asserting `/spaces` output contains no other user's name**
  (the leak is closed).

## Files

- `src/db/schema.sql` — `space_invites` table + index.
- `src/db/spaceInvites.ts` — **new**; `createInvite`, `getValidInvite`,
  `redeemInvite` (+ code generator).
- `src/agent/tools/spaces.ts` — drop `add_member`; add `invite` + `redeem`; remove
  `listAllowlisted` import.
- `src/web/routes/spaces.ts` — remove datalist + by-name add route; add generate +
  redeem routes/controls.
- Tests: `tests/db/space-invites.test.ts` (new), `tests/agent/tools/spaces.test.ts`
  (update), `tests/web/spaces-route.test.ts` (update: no-enumeration + invite flow).

## Conflicts

Isolated to the spaces surface (`db/spaces*`, `agent/tools/spaces.ts`,
`web/routes/spaces.ts`) — no overlap with the reminders/scheduler work. Belongs
with the #3 security pass conceptually (authorization/enumeration hardening).
