import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import type { ChannelAdapter } from '../channels/adapter.js';
import type { GenerateFn } from '../agent/core.js';
import { dueJobs, markDone, type Job } from '../db/jobs.js';

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
      } else {
        await deps.fireReminder(deps, job);
      }
      markDone(deps.db, job.id);
    } catch (err) {
      console.error(`job ${job.id} (${job.type}) failed:`, err);
      // left pending → retried next tick
    }
  }
}

export function startScheduler(deps: SchedulerDeps): { stop(): void } {
  const timer = setInterval(() => {
    void tick(deps, Date.now());
  }, POLL_MS);
  return { stop: () => clearInterval(timer) };
}
