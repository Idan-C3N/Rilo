import type { Job } from '../db/jobs.js';
import type { SchedulerDeps } from './scheduler.js';
import { getUserById, getExternalId } from '../db/users.js';
import { resolveModels } from '../agent/models.js';
import { addMessage } from '../db/messages.js';

const REMINDER_SYSTEM =
  'You are a personal assistant delivering a scheduled reminder. Phrase it warmly and briefly in one short message. Do not add unrelated content.';

const FOLLOWUP_SYSTEM =
  'You are a personal assistant following up on a task the user meant to do. Ask, warmly and briefly, whether they did it.';

export async function fireReminder(deps: SchedulerDeps, job: Job): Promise<void> {
  const user = getUserById(deps.db, job.user_id);
  if (!user) return;
  const ext = getExternalId(deps.db, user.id, deps.channel);
  if (!ext) return;
  const text = String(job.payload.text ?? job.payload.task ?? 'your reminder');
  const models = resolveModels(deps.db, deps.appCfg, user.id);
  const system = job.type === 'followup' ? FOLLOWUP_SYSTEM : REMINDER_SYSTEM;
  const result = await deps.generate({
    model: models.cheap,
    system,
    messages: [{ role: 'user', content: `Deliver this reminder to the user: "${text}"` }],
  });
  addMessage(deps.db, user.id, 'assistant', result.text);
  await deps.adapter.send(ext, result.text);
}
