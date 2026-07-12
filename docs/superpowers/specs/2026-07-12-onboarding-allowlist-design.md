# Self-service onboarding + owner approval (drop manual SQL allowlisting)

**Date:** 2026-07-12
**Issue:** #9
**Status:** Approved (brainstorm complete)
**Branch:** `feat/9-onboarding` off `main`

## Goal

Replace hand-editing `UPDATE users SET allowlisted=1` with a self-service flow: a stranger
registers on the public web page, proves their phone via a Telegram contact-share, the owner
gets a Telegram ping and approves (Telegram command **or** web button), and the user is in.

## Decisions (resolved in brainstorm)

- **Model 2 — self-service register → owner approves each.** Not fully open, not
  pre-authorized phones. Phone-verify proves identity; the owner authorizes.
- **Phone verified via Telegram contact-share** (`request_contact`), not a typed number —
  the shared `phone_number` is Telegram-verified.
- **Phone match = last 8 digits** of a digits-only normalization (handles `+972…` / `05…`).
- **Owner = `OWNER_TELEGRAM_ID`** (env), auto-allowlisted + `is_owner` on boot.
- **Owner ping always → `OWNER_TELEGRAM_ID` over Telegram**, regardless of the requester's
  channel (one owner inbox).
- **Approve via both** `/approve|/deny <id>` (Telegram) and an **owner-only** web Pending list.
- **Channel-neutral core; Telegram is channel #1.** Channel-specific bits (deep link,
  contact-share) sit behind adapter seams so a future WhatsApp/Slack adapter can implement them.

## Data model

New table `pending_registrations`:

| col | notes |
|---|---|
| `id` | pk |
| `name` | from the web form |
| `phone` | normalized (digits only) |
| `code` | random, unguessable; used in the deep link |
| `channel` | `'telegram'` for now |
| `channel_user_id` | null until `/start <code>` binds the requester |
| `user_id` | null until the user row is created/linked |
| `status` | `awaiting_start` → `awaiting_contact` → `pending_approval` → `approved` \| `denied` |
| `created_at`, `expires_at` | code TTL (e.g. 30 min for the start step) |

`users` gains **`is_owner`** (0/1). Migration adds the table + column (both idempotent;
existing rows default `is_owner=0`).

`db/registrations.ts` (new): `createRegistration`, `findByCode`, `bindRequester(regId, channelUserId, userId)`, `findAwaitingContact(channel, channelUserId)`, `markPendingApproval`, `listPending`, `approve(regId)`, `deny(regId)`, plus `normalizePhone(s)` (digits only) and `phoneMatches(a,b)` (last-8 compare).

## Channel seams (added to `channels/adapter.ts`, implemented in `telegram.ts`)

- `registrationLink(code: string): string` — Telegram: `https://t.me/<botUsername>?start=<code>`
  (bot username fetched once via `getMe` at startup).
- `requestContact(channelUserId: string, text: string): Promise<void>` — prompt with the
  channel's share-phone affordance. Telegram: a one-time keyboard with a `request_contact` button.
- `InboundMessage.contact?: { phone: string }` — set when the inbound is a shared contact
  (Telegram maps `ctx.message.contact.phone_number`). `text` may be empty for such messages.
- `InboundMessage` already has `channel` + `channelUserId`; `/start <code>` arrives as normal
  text and is parsed in dispatch.

## Flow (Telegram)

1. **Web `GET /register`** (public): form → name + phone.
2. **`POST /register`**: `normalizePhone`, `createRegistration{status:'awaiting_start'}`, render
   the page with `registrationLink(code)` (+ the raw code as fallback).
3. User clicks → bot receives **`/start <code>`**:
   - `findByCode`; if missing/expired/used → reply "registration expired — register again."
   - else `bindRequester` (the requester's user row is created via the existing
     `getUserByIdentity`/`createUserWithIdentity` path), set `status:'awaiting_contact'`,
     `adapter.requestContact(channelUserId, "Tap to share your number to finish verifying.")`.
4. User taps share → inbound with `contact.phone`:
   - `findAwaitingContact(channel, channelUserId)`; none → "please register first."
   - `phoneMatches(contact.phone, reg.phone)` (last-8):
     - **match** → `markPendingApproval`, ping owner via Telegram
       (`telegramAdapter.send(OWNER_TELEGRAM_ID, "📥 <name> (…<last4>) wants access. /approve <userId>  /deny <userId>")`),
       reply user "Request sent — you'll get a message when approved."
     - **no match** → "that number doesn't match your registration."
5. **Owner** `/approve <userId>` or `/deny <userId>` (Telegram), or the web Pending list:
   - approve → `setAllowlisted(userId, true)`, mark reg `approved`, reply the user
     "You're in! Send `/login`."
   - deny → mark `denied` (user stays un-allowlisted).

## Dispatch rework (`agent/dispatch.ts`)

Order inside `handleInbound`, **before** the allowlist gate:

1. Resolve/create user (existing).
2. If `text` is `/start <code>` → registration bind + request contact (above). Return.
3. If `m.contact` present → phone-match + notify owner (above). Return.
4. If user `is_owner` and `text` is `/approve <id>` or `/deny <id>` → do it, notify. Return.
5. **Allowlist gate:** if `!isAllowlisted(user)` → reply based on state: a `pending_approval`
   reg → "Your request is awaiting approval"; otherwise `NOT_AUTHORIZED` **with a register
   hint** (`${webBaseUrl}/register`). Return.
6. Normal handling (`/login`, agent turn) unchanged.

`DispatchDeps` gains `ownerTelegramId` and a way to reach the Telegram adapter for the owner
ping (the existing `adapter` is the Telegram adapter in the running app; the owner-notify
helper takes `adapter.send`).

## Web (`web/routes/`, `web/server.ts`)

- **`web/routes/register.ts`** (new): `GET /register` (form, `{bare:true}` layout, public),
  `POST /register` (create + show deep link). Add `/register` to `PUBLIC_PATHS`.
- **Pending list** (owner-only): `GET /users/pending` (list `listPending()` with Approve/Deny
  forms), `POST /users/:id/approve`, `POST /users/:id/deny`. Guard: load `req.userId`'s user,
  **403 unless `is_owner`**. POST + the now-`SameSite=Lax` session cookie cover CSRF baseline
  (full CSRF token + rate-limit → #3). Link the Pending page from Home/nav for the owner only.

## Boot (`index.ts`)

Seed the owner: ensure a Telegram identity `external_id = OWNER_TELEGRAM_ID` exists; if not,
create a user, link the identity, `setAllowlisted(true)`, set `is_owner=1`. Idempotent on
every boot. If `OWNER_TELEGRAM_ID` is unset, skip (log a warning — no owner ⇒ nobody can approve).

## Config

`config.ts`: `ownerTelegramId` ← `OWNER_TELEGRAM_ID` (string, optional). `.env.example` entry
with a note that it's required for approvals to work.

## Files touched

- **New:** `src/db/registrations.ts`, `src/web/routes/register.ts`, migration (table + `is_owner`).
- `src/db/users.ts` (owner helpers: `setOwner`, `isOwner`, and a status-aware "pending?" query
  or via registrations).
- `src/agent/dispatch.ts` (handshake + owner commands + reworked gate).
- `src/channels/adapter.ts` + `src/channels/telegram.ts` (`registrationLink`, `requestContact`,
  `contact` inbound, bot username via `getMe`).
- `src/web/server.ts` (PUBLIC_PATHS `/register`; register + pending routes; owner-only guard).
- `src/config.ts`, `src/index.ts`, `.env.example`.

## Testing

- **`db/registrations.test.ts`**: create/find/bind/status transitions; `normalizePhone`
  (`+972-50-123 4567` → `972501234567`); `phoneMatches` last-8 (matches across `+972…`/`05…`
  representations; rejects a genuinely different number).
- **`agent/dispatch.test.ts`**: `/start <code>` binds + requests contact; a matching contact →
  owner ping sent + user set pending; non-matching contact → rejected, no ping; `/approve <id>`
  by owner allowlists + notifies; `/approve` by a **non-owner** does nothing; gate replies with
  the register hint / pending message appropriately.
- **`web` route tests**: `GET /register` public (200, no auth); `POST /register` creates a reg +
  page shows a `t.me/...?start=` link; `GET /users/pending` as non-owner → 403; as owner → lists;
  `POST /users/:id/approve` as owner allowlists, as non-owner → 403.
- **`channels/telegram.test.ts`**: `requestContact` sends a `request_contact` keyboard;
  `registrationLink` builds the `t.me` URL; an inbound contact maps to `InboundMessage.contact`.

## Out of scope / deferred

- Other channel adapters (WhatsApp/Slack) — seams only, no impl (YAGNI).
- Rate-limiting `/register` + verify attempts, CSRF token, `Secure` cookie → **#3**.
- Pre-authorized-phone or invite-code models — rejected in brainstorm.
- Removing the manual SQL path — the helpers stay usable, just no longer required.

## Verification (Definition of Done)

- `npm test` green; `tsc --noEmit` clean.
- Manual: from a fresh (non-owner) Telegram account → `/register` on web → click the deep link
  → share contact → owner receives the ping → `/approve` → the user gets "you're in" and can
  `/login`. Non-owner `/approve` is a no-op. Owner web Pending list shows/acts on the queue.

## Conflicts / sequencing (with #11)

Both touch `agent/dispatch.ts`, `web/server.ts`, `channels/adapter.ts`, `channels/telegram.ts`.
Edits are in **different regions**: #11 rewrites the `/login` handler + login route + adds
`disableLinkPreview` to `send`; #9 adds the registration handshake/owner commands + the gate +
`registrationLink`/`requestContact`/`contact`. Both extend the `adapter` interface (additive).
Expect a **rebase with small conflicts** for whichever merges second (dispatch `handleInbound`
ordering; the adapter interface). #11's `SameSite=Lax` is already on `main`, so #9 inherits it.
Build in parallel; merge sequentially, second rebases.
