import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import type { ChannelAdapter } from '../channels/adapter.js';
import type { GenerateFn } from '../agent/core.js';
import { dueJobs, markDone, rearmJob, type Job } from '../db/jobs.js';
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

const POLL_MS = 15000;

export async function tick(deps: SchedulerDeps, now: number): Promise<void> {
  for (const job of dueJobs(deps.db, now)) {
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
      // left pending → retried next tick; not re-armed until a successful fire
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

export function startScheduler(deps: SchedulerDeps): { stop(): void } {
  const timer = setInterval(() => {
    void tick(deps, Date.now());
  }, POLL_MS);
  return { stop: () => clearInterval(timer) };
}
