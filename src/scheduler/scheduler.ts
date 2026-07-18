import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import type { ChannelAdapter } from '../channels/adapter.js';
import type { GenerateFn } from '../agent/core.js';
import { claimDueJobs, reclaimOrphans, failJob, markDone, rearmJob, type Job } from '../db/jobs.js';
import { getUserById } from '../db/users.js';
import { nextFireAt } from './recurrence.js';

export interface SchedulerDeps {
  db: DB;
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>;
  adapter: Pick<ChannelAdapter, 'send'>;
  generate: GenerateFn;
  channel: string;
  fireReminder: (deps: SchedulerDeps, job: Job) => Promise<void>;
  fireHeartbeat: (deps: SchedulerDeps, job: Job) => Promise<void>;
}

export const POLL_MS = 15000;
export const BATCH = 100;        // max jobs claimed per tick (bounds a single tick's work)
export const MAX_ATTEMPTS = 5;   // retire a repeatedly-failing job to 'failed' after this many tries

export async function tick(deps: SchedulerDeps, now: number): Promise<void> {
  // Atomically claim a bounded batch (pending -> running) up front, so an
  // overlapping tick can never see or re-dispatch these same rows.
  for (const job of claimDueJobs(deps.db, now, BATCH)) {
    try {
      if (job.type === 'heartbeat') {
        await deps.fireHeartbeat(deps, job);
        markDone(deps.db, job.id); // heartbeat reschedules itself by inserting a new job
      } else {
        await deps.fireReminder(deps, job);
        reschedule(deps, job, now);
      }
    } catch (err) {
      console.error(`job ${job.id} (${job.type}) failed:`, err);
      // Increment attempts; re-arm to pending for retry, or retire to 'failed'
      // once MAX_ATTEMPTS is reached (stops a poison job looping forever).
      failJob(deps.db, job.id, MAX_ATTEMPTS);
    }
  }
}

// One-shot → markDone. Recurring → compute the next occurrence from `now`
// (skip-to-next: a downtime gap yields a single future fire), decrement the
// count if capped, and retire when the expression is exhausted, the count hits
// 0, or the next occurrence would pass recurrence_until. Otherwise re-arm.
function reschedule(deps: SchedulerDeps, job: Job, now: number): void {
  if (!job.recurrence) {
    markDone(deps.db, job.id);
    return;
  }
  const tz = getUserById(deps.db, job.user_id)?.tz ?? 'UTC';
  const next = nextFireAt(job.recurrence, tz, now);
  const nextCount = job.recurrence_count == null ? null : job.recurrence_count - 1;
  const capReached =
    next === null ||
    (job.recurrence_until != null && next > job.recurrence_until) ||
    nextCount === 0;
  if (capReached) {
    markDone(deps.db, job.id);
  } else {
    rearmJob(deps.db, job.id, next!, nextCount);
  }
}

// Self-scheduling setTimeout chain (not setInterval): the next tick is armed
// only AFTER the current one fully awaits. setInterval fired every POLL_MS
// regardless of tick duration, so a tick running longer than POLL_MS overlapped
// itself and, before atomic claiming, double-dispatched the same due rows.
export function startScheduler(deps: SchedulerDeps): { stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  reclaimOrphans(deps.db); // recover jobs stranded 'running' by a prior crash/restart
  const loop = async (): Promise<void> => {
    if (stopped) return;
    await tick(deps, Date.now());
    if (stopped) return;
    timer = setTimeout(() => void loop(), POLL_MS);
  };
  timer = setTimeout(() => void loop(), POLL_MS);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
