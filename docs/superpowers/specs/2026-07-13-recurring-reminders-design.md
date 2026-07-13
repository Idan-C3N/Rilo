# Recurring Reminders — Design

**Date:** 2026-07-13
**Backlog:** #14
**Status:** Approved (brainstorm complete)

## Goal

Let a user set a **repeating** reminder — "remind me every Monday 09:00", "every
day at 15:30", "every 2 hours" — instead of only a one-shot. Repetition may carry
an optional **cap**: "daily **for a week**", "remind me **5 times**", "every Monday
**until March**". Uncapped recurrence ("every Monday") runs indefinitely until the
user cancels it. The user can see and cancel active recurring reminders both by
talking to the bot and from the web UI.

## Scope

**In scope:** recurring reminders (the `remind` tool / `jobs` `type='reminder'`
path), optional caps (until-date and/or count), a management surface (bot tools +
web list with cancel).

**Explicitly deferred (stay in backlog):**

- **#15 shared-space reminders** — fanning a reminder out to all members of a
  space. Builds directly on this schema/fire work; deferred to validate the
  recurrence engine in production for a few days first.
- **Recurring `track`/followups** — `track` stays one-shot; only `reminder` gains
  recurrence.
- **Editing** an existing recurring reminder in place — user cancels and re-creates.

## Current State (verified against HEAD)

- `remind` tool is **one-shot only**: input `delay_minutes`, computes
  `fire_at = Date.now() + delay*60000`, inserts one `jobs` row, fires once
  (`src/agent/tools/remind.ts`). `track` is likewise one-shot `followup`
  (`src/agent/tools/track.ts`).
- The scheduler is a single JS poll loop — `setInterval(tick, 15000)`
  (`src/scheduler/scheduler.ts`). `tick` selects `dueJobs` (`fire_at <= now`,
  `status='pending'`), fires each, then `markDone`. **No cron daemon exists
  anywhere in the app**; "cron" below refers only to a cron-expression *string*
  used as a compact recurrence descriptor.
- **No re-arm** for reminders/followups — `markDone` is terminal
  (`src/db/jobs.ts` `markDone`). The **only** self-rescheduling construct is the
  heartbeat, which inserts a fresh heartbeat job each fire
  (`src/scheduler/heartbeat.ts`); its self-reschedule pattern is the model to
  mirror, but it inserts a new row rather than updating in place.
- `jobs` table: `id, user_id, type, fire_at, payload_json, status, created_at`
  (`src/db/schema.sql:48-57`), index `idx_jobs_due(status, fire_at)`. No
  recurrence / next-run / cap columns. `type` ∈ `reminder | followup | heartbeat`.
- `fire.ts` delivers a reminder to a single `job.user_id` (resolve user → allowlist
  gate → channel identity → generate warm phrasing → send) (`src/scheduler/fire.ts`).
- Per-user timezone + quiet hours already exist: `users.tz` (default `'UTC'`),
  `users.quiet_start/quiet_end` (`schema.sql:1-7`), applied by `isQuiet`
  (`src/scheduler/quiet.ts`). Note: reminder delivery does **not** currently honor
  quiet hours — only the heartbeat does. This design does not change that (see
  Non-goals).
- Migrations are idempotent `ALTER TABLE … ADD COLUMN` guarded by a
  `PRAGMA table_info` presence check (`src/db/db.ts:27` `migrate`). New columns on
  existing tables follow this pattern.

## Decisions (from brainstorm)

1. **Recurrence model = cron string.** Smallest model covering all real asks
   ("every Mon 09:00", "daily 15:30", "every N hours") in one field. Interval-only
   can't express wall-clock times; RRULE is overkill.
2. **Timezone = `users.tz`,** passed to the cron parser so occurrences land at the
   user's local wall-clock time; DST handled by the parser.
3. **Missed fires = skip to next.** Next occurrence is always computed from *now*,
   so a downtime gap yields one delivery + the next future occurrence — never a
   burst of stale reminders on restart.
4. **Caps = both, end on first hit.** `recurrence_until` (epoch ms) and
   `recurrence_count` (remaining fires); the reminder retires when either is
   satisfied. Both NULL = runs forever.
5. **Re-arm = update the row in place** (not insert-new like heartbeat). One row =
   one recurring reminder → natural identity for list/cancel.
6. **Management = bot tools + web list, with cancel available in both.**

## Architecture

### 1. Data model — `db/schema.sql` + `db/db.ts` migration

Three nullable columns on `jobs`. All NULL ⇒ one-shot (existing behavior, fully
backward-compatible):

- `recurrence TEXT` — cron expression, e.g. `"0 9 * * 1"` (Mon 09:00).
- `recurrence_until INTEGER` — epoch ms; retire once the next occurrence would be
  after this.
- `recurrence_count INTEGER` — remaining fires; retire when it reaches 0.

`CREATE TABLE` in `schema.sql` gains the columns (for fresh DBs). `migrate` in
`db.ts` gains a `PRAGMA table_info(jobs)` guard adding each column if absent
(existing rows → NULL → one-shot). `idx_jobs_due(status, fire_at)` is unchanged and
still covers the poll query.

### 2. Next-fire module — `scheduler/recurrence.ts` (new)

Isolates the one new external dependency (`cron-parser`).

```
nextFireAt(cron: string, tz: string, after: number): number | null
```

Parses `cron` with `{ currentDate: new Date(after), tz }`, returns the epoch ms of
the next occurrence strictly after `after`, or `null` if the expression yields none
(e.g. malformed / exhausted). Pure and unit-testable in isolation. May also expose a
small `describeCron(cron): string` helper for human-readable listing, or that can
live in the management tool — implementation detail for the plan.

### 3. Jobs layer — `db/jobs.ts`

- `Job` interface + `hydrate` gain `recurrence`, `recurrence_until`,
  `recurrence_count` (all optional/nullable).
- `addJob` accepts optional `recurrence`, `recurrenceUntil`, `recurrenceCount`;
  INSERT includes the new columns (defaulting NULL). One-shot callers unchanged.
- `rearmJob(db, id, fireAt, count)` — `UPDATE jobs SET fire_at=?, recurrence_count=?
  WHERE id=?`, leaving `status='pending'`.
- `listRecurring(db, userId)` — active (`status='pending'`, `recurrence IS NOT
  NULL`) reminders for the caller, for the management surface.

### 4. Scheduler re-arm — `scheduler/scheduler.ts` `tick`

After a reminder fires successfully, branch instead of always calling `markDone`:

- **Non-recurring** (`recurrence` NULL): `markDone` — exactly as today.
- **Recurring:** resolve the job's owner tz (`getUserById(job.user_id).tz`, default
  `'UTC'`) — `tick` does not load the user today, so this is a new lookup on the
  recurring branch only. Compute `next = nextFireAt(recurrence, tz, Date.now())`;
  compute `nextCount = recurrence_count != null ? recurrence_count - 1 : null`.
  Retire (`markDone`) if any of: `next === null`, `recurrence_until != null &&
  next > recurrence_until`, or `nextCount === 0`. Otherwise `rearmJob(id, next,
  nextCount)`.
- **Heartbeat path is untouched** — it keeps its own insert-new reschedule in
  `fireHeartbeat`.

Failure semantics are preserved: if `fireReminder` throws, the job is left pending
(re-tried next tick) and is neither retired nor re-armed — same as today.

### 5. `remind` tool — `agent/tools/remind.ts`

Add optional args alongside the existing `delay_minutes`:

- `recurrence` (cron string), `recurrence_until` (epoch ms), `recurrence_count`.

The tool description instructs the agent to translate natural language into a cron
expression and to pick cap fields from the phrasing — "daily for a week" → daily
cron + `recurrence_until = now + 7d`; "5 times" → `recurrence_count = 5`; "every
Monday" → cron, no cap. When `recurrence` is set, `fire_at` = the first occurrence
(`nextFireAt(cron, tz, now)`) rather than `now + delay`. The pure one-shot path
(`delay_minutes`, no recurrence) is unchanged.

### 6. Management — `agent/tools/reminders.ts` (new) + `web/`

- **Bot tools:** `list_reminders` (returns the caller's active recurring reminders:
  id, human-readable schedule, next fire time, remaining cap) and
  `cancel_reminder(id)` → `cancelJob`, gated to the caller's own `user_id`.
- **Web:** a "Reminders" section listing the logged-in user's active recurring
  reminders with a **Cancel** button per row. Cancel is an authenticated POST route
  scoped to the session user, with an htmx inline swap on success — mirroring the
  existing Services toggle/delete pattern in `web/`.

## Error Handling

- **Bad cron from the agent:** `nextFireAt` returns `null`; the `remind` tool
  rejects with an error result (agent surfaces it / retries) rather than storing an
  unfireable job. If a stored job ever yields `null` at re-arm time, it retires
  (`markDone`) rather than looping.
- **Cancel of a non-owned / missing id:** no-op / not-found result; never cancels
  another user's job.
- **Delivery failure mid-recurrence:** job left pending, retried next tick (existing
  behavior); re-arm only happens after a successful fire.

## Testing

- **`recurrence.ts`:** cron + tz → correct next occurrence; a DST-boundary case; a
  malformed expression → `null`.
- **`db/jobs.ts`:** `rearmJob` updates `fire_at` + count and keeps status pending;
  `addJob` persists recurrence fields; migration on a pre-existing `jobs` table
  leaves old rows one-shot (NULL columns).
- **`scheduler`:** a recurring job fires N times then retires by count; retires once
  the next occurrence passes `recurrence_until`; an uncapped job re-arms
  indefinitely; a one-shot job still fires exactly once (regression); a simulated
  downtime gap produces a single catch-up delivery, not one per missed occurrence.
- **`remind` tool:** natural-language recurrence/cap args are stored correctly;
  first `fire_at` is the first occurrence, not `now + delay`.
- **web:** the list route shows only the caller's reminders; the cancel route
  cancels only a caller-owned id and rejects others.

## Non-goals / Notes

- Reminder delivery still does **not** apply quiet hours (unchanged from today);
  adding quiet-hours to reminders is out of scope and can be revisited with #15
  (where per-member quiet hours become material).
- `track`/followups remain one-shot.
- No editing of existing recurring reminders — cancel + re-create.

## Files

- `src/db/schema.sql` — `recurrence`, `recurrence_until`, `recurrence_count` on `jobs`.
- `src/db/db.ts` — `migrate` guard adding the three columns.
- `src/db/jobs.ts` — types, `addJob` args, `rearmJob`, `listRecurring`.
- `src/scheduler/recurrence.ts` — **new**; `nextFireAt` (+ optional `describeCron`).
- `src/scheduler/scheduler.ts` — re-arm branch in `tick`.
- `src/agent/tools/remind.ts` — recurrence + cap args.
- `src/agent/tools/reminders.ts` — **new**; `list_reminders`, `cancel_reminder`.
- `src/agent/tools/index.ts` — register the new tools.
- `src/web/` — Reminders list section + authenticated cancel route (htmx swap).
- `package.json` — add `cron-parser`.

## Conflicts

Isolated to the `jobs` / scheduler surface plus one additive web section — **no
collision with the #3 auth cluster** (`web/server.ts` login/dispatch paths are
untouched beyond adding one route + one view section). Prerequisite for #15
(shared-space reminders build on this schema and the fan-out point in `fire.ts`).
