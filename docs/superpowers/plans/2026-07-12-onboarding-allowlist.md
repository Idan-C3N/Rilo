# Self-service Onboarding + Owner Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace manual SQL allowlisting with a self-service web `/register` → Telegram contact-share verify → owner approval flow.

**Architecture:** Channel-neutral core (`db/registrations.ts` + dispatch handlers) with Telegram as channel #1. New `pending_registrations` table + `users.is_owner`. Owner approves via Telegram command or an owner-only web Pending list. Owner seeded at boot from `OWNER_TELEGRAM_ID`.

**Tech Stack:** TypeScript (ESM), better-sqlite3, Fastify, grammy, vitest.

## Global Constraints

- Web approve/deny + Pending list are **OWNER-ONLY**: check `is_owner` on the session user, **403** otherwise. Approve/deny are **POST**.
- Guard approve to only flip users currently in `pending_approval` status.
- Do NOT edit `db/sessions.ts` or the `/login` route logic (owned by #11).
- Phone match = last 8 digits of a digits-only normalization.
- Owner ping always goes to `OWNER_TELEGRAM_ID` over Telegram.
- Migration (table + `is_owner` column) must be idempotent.

---

### Task 1: Migration — `pending_registrations` table + `users.is_owner`

**Files:**
- Modify: `src/db/schema.sql` (add `is_owner` to users; add `pending_registrations`)
- Modify: `src/db/db.ts` (idempotent ALTER for existing DBs)
- Test: `tests/db/db.test.ts`

- [ ] Add `is_owner INTEGER NOT NULL DEFAULT 0` to the `users` CREATE TABLE.
- [ ] Add `pending_registrations` CREATE TABLE IF NOT EXISTS with cols: id, name, phone, code (UNIQUE), channel (default 'telegram'), channel_user_id, user_id (FK users ON DELETE CASCADE), status (default 'awaiting_start'), created_at, expires_at. Indexes on code and (channel, channel_user_id).
- [ ] In db.ts, after `db.exec(schema)`, run `migrate(db)` that checks `PRAGMA table_info(users)` and ALTERs `is_owner` if missing.
- [ ] Test: openDb includes `pending_registrations` in the table list and `users` has `is_owner` column.

### Task 2: `db/registrations.ts` — phone helpers + registration lifecycle

**Files:**
- Create: `src/db/registrations.ts`
- Test: `tests/db/registrations.test.ts`

**Produces:**
- `normalizePhone(s: string): string` — digits only.
- `phoneMatches(a: string, b: string): boolean` — last-8 compare (empty ⇒ false).
- `RegStatus`, `Registration` types.
- `createRegistration(db, {name, phone, channel?}): Registration` — random code, status `awaiting_start`, 30-min expiry.
- `findByCode(db, code): Registration | undefined`
- `bindRequester(db, regId, channelUserId, userId): void` — sets status `awaiting_contact`.
- `findAwaitingContact(db, channel, channelUserId): Registration | undefined`
- `markPendingApproval(db, regId): void`
- `findPendingByUserId(db, userId): Registration | undefined`
- `listPending(db): Registration[]`
- `approve(db, regId): void` / `deny(db, regId): void`

- [ ] Tests: normalizePhone strips punctuation; phoneMatches across `+972…`/`05…`, rejects different numbers, false on empty; create/find/bind/markPendingApproval/approve/deny status transitions; findAwaitingContact + findPendingByUserId lookups.
- [ ] Implement to pass.

### Task 3: `db/users.ts` — owner helpers + `ensureOwner`

**Files:**
- Modify: `src/db/users.ts` (User gains `is_owner`; add `setOwner`, `isOwner`, `ensureOwner`)
- Test: `tests/db/users.test.ts`

**Produces:**
- `setOwner(db, userId, on): void`, `isOwner(db, userId): boolean`
- `ensureOwner(db, telegramExternalId): User` — idempotent: create-if-missing, allowlist + set owner.

- [ ] Tests: setOwner/isOwner round-trip; ensureOwner creates+allowlists+owns; second call idempotent (no dup user).
- [ ] Implement.

### Task 4: Channel seams — adapter interface + Telegram impl

**Files:**
- Modify: `src/channels/adapter.ts` (`InboundMessage.contact`; `registrationLink`, `requestContact` on ChannelAdapter)
- Modify: `src/channels/telegram.ts` (`getMe`/`ensureBotUsername`, `registrationLink`, `requestContact`, contact inbound)
- Test: `tests/channels/telegram.test.ts`

- [ ] Tests: `registrationLink(code)` builds `https://t.me/<username>?start=<code>` (username via getMe/ensureBotUsername or deps.botUsername); `requestContact` sends a message with a `request_contact` keyboard button; an inbound `message:contact` maps to `InboundMessage.contact.phone`, text `''`.
- [ ] Implement. Update fake bot to route handlers by event.

### Task 5: Dispatch rework — handshake, owner commands, gate

**Files:**
- Modify: `src/agent/dispatch.ts`
- Test: `tests/agent/dispatch.test.ts`

**Order in handleInbound (after resolve/create user, before allowlist gate):**
1. `/start <code>` → findByCode (reject if missing/expired/used) → bindRequester → requestContact. Return.
2. `m.contact` → findAwaitingContact → phoneMatches: match ⇒ markPendingApproval + owner ping + user ack; no match ⇒ reject. Return.
3. owner + `/approve <id>`|`/deny <id>` → findPendingByUserId; approve ⇒ setAllowlisted+approve+notify user; deny ⇒ deny reg+notify. Return.
4. Gate: `!isAllowlisted` → pending reg ⇒ "awaiting approval"; else NOT_AUTHORIZED + `${webBaseUrl}/register` hint. Return.
5. Normal handling unchanged.

- [ ] Add `ownerTelegramId?: string` to DispatchDeps; widen adapter type to include `requestContact`.
- [ ] Tests: /start binds + requestContact; matching contact → owner ping sent + pending; non-matching → rejected, no ping; /approve by owner allowlists + notifies user; /approve by non-owner does not allowlist; gate register-hint vs pending message. Update existing NOT_AUTHORIZED test to assert contains hint.
- [ ] Implement.

### Task 6: Web — public `/register` + owner-only Pending

**Files:**
- Create: `src/web/routes/register.ts` (public GET/POST /register)
- Create: `src/web/routes/pending.ts` (owner-only GET /users/pending, POST approve/deny)
- Modify: `src/web/server.ts` (PUBLIC_PATHS + wire routes; WebDeps gains `registrationLink`, `notify`)
- Modify: `src/web/routes/home.ts` (owner-only Pending link)
- Test: `tests/web/register-route.test.ts`, `tests/web/pending-route.test.ts`

- [ ] Tests: GET /register public 200 no auth; POST /register creates a reg + page shows `t.me/...?start=` link; GET /users/pending non-owner 403 / owner lists; POST /users/:id/approve non-owner 403, owner allowlists + marks approved.
- [ ] Implement. Owner guard: `isOwner(db, req.userId)` else 403. Approve guard: only `findPendingByUserId`.

### Task 7: Config + boot wiring

**Files:**
- Modify: `src/config.ts` (`ownerTelegramId` ← OWNER_TELEGRAM_ID)
- Modify: `.env.example`
- Modify: `src/index.ts` (ensureOwner at boot; ensureBotUsername; wire dispatch + web deps)
- Test: `tests/config.test.ts`

- [ ] Test: loadConfig maps OWNER_TELEGRAM_ID → ownerTelegramId (optional).
- [ ] Implement config + .env.example note. Wire index.ts: ensureOwner if set (else warn), best-effort ensureBotUsername, pass ownerTelegramId+adapter to dispatch, registrationLink+notify to web.

### Task 8: Verify + review

- [ ] `npm test` green; `npm run typecheck` clean.
- [ ] superpowers:requesting-code-review; address findings.
- [ ] Commit.
