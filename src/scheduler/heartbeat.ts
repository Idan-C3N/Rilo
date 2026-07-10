import { z } from 'zod';
import { generateObject } from 'ai';
import type { Job } from '../db/jobs.js';
import type { SchedulerDeps } from './scheduler.js';
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { getUserById, getExternalId, listAllowlisted } from '../db/users.js';
import { addJob, pendingHeartbeat } from '../db/jobs.js';
import { addMessage } from '../db/messages.js';
import { recall } from '../db/memory.js';
import { buildContext } from '../agent/history.js';
import { resolveModels } from '../agent/models.js';
import { isQuiet } from './quiet.js';

export interface HeartbeatDeps extends SchedulerDeps {
  decideHeartbeat?: (deps: HeartbeatDeps, userId: number) => Promise<{ act: boolean; message?: string }>;
}

const GATE_SYSTEM =
  'You are a proactive personal assistant. Given the user\'s memory, tracked tasks, recent conversation, and the current time, decide whether there is something worth proactively messaging them about right now (an overdue tracked task, a timely nudge, a relevant follow-up). Only act if it genuinely adds value; prefer silence. If you act, write the exact short message to send.';

export async function decideHeartbeat(
  deps: HeartbeatDeps,
  userId: number,
): Promise<{ act: boolean; message?: string }> {
  const models = resolveModels(deps.db, deps.appCfg, userId);
  const ctx = buildContext(deps.db, userId, 15);
  const facts = recall(deps.db, userId).map((m) => m.text).join('\n');
  const nowIso = new Date(Date.now()).toISOString();
  const { object } = await generateObject({
    model: models.cheap,
    schema: z.object({ act: z.boolean(), message: z.string().optional() }),
    system: GATE_SYSTEM,
    prompt: `Current time (UTC): ${nowIso}\n\nMemory/facts:\n${facts || '(none)'}\n\nConversation summary:\n${ctx.system ?? '(none)'}\n\nRecent messages:\n${ctx.messages.map((m) => `${m.role}: ${m.content}`).join('\n') || '(none)'}`,
  });
  return object;
}

export async function fireHeartbeat(deps: HeartbeatDeps, job: Job): Promise<void> {
  const user = getUserById(deps.db, job.user_id);
  if (!user) return; // user deleted — nothing to reschedule from

  // 1. ALWAYS reschedule the next heartbeat first (before quiet/identity checks).
  addJob(deps.db, {
    userId: user.id,
    type: 'heartbeat',
    fireAt: Date.now() + user.heartbeat_interval_min * 60000,
    payload: {},
  });

  // 2. Quiet hours → silent (already rescheduled).
  if (isQuiet(user, Date.now())) return;

  // 3. Resolve delivery target; if none, skip messaging (already rescheduled).
  const ext = getExternalId(deps.db, user.id, deps.channel);
  if (!ext) return;

  // 4. Gate decision + act.
  const decide = deps.decideHeartbeat ?? decideHeartbeat;
  const decision = await decide(deps, user.id);
  if (decision.act && decision.message) {
    addMessage(deps.db, user.id, 'assistant', decision.message);
    await deps.adapter.send(ext, decision.message);
  }
}

export function seedHeartbeats(db: DB, _appCfg: Pick<AppConfig, 'openrouterKeyFallback'>): void {
  for (const u of listAllowlisted(db)) {
    if (!pendingHeartbeat(db, u.id)) {
      addJob(db, {
        userId: u.id,
        type: 'heartbeat',
        fireAt: Date.now() + u.heartbeat_interval_min * 60000,
        payload: {},
      });
    }
  }
}
