import type { Job } from '../db/jobs.js';
import type { SchedulerDeps } from './scheduler.js';
import { getUserById, getExternalId } from '../db/users.js';
import { resolveModels } from '../agent/models.js';
import { addMessage } from '../db/messages.js';

const REMINDER_SYSTEM =
  'You are a personal assistant delivering a scheduled reminder. Phrase it warmly and briefly in one short message. Do not add unrelated content.';

export async function fireReminder(deps: SchedulerDeps, job: Job): Promise<void> {
  const user = getUserById(deps.db, job.user_id);
  if (!user) return;
  const ext = getExternalId(deps.db, user.id, deps.channel);
  if (!ext) return;
  const text = String(job.payload.text ?? 'your reminder');
  const models = resolveModels(deps.db, deps.appCfg, user.id);
  const result = await deps.generate({
    model: models.cheap,
    system: REMINDER_SYSTEM,
    messages: [{ role: 'user', content: `Deliver this reminder to the user: "${text}"` }],
  });
  addMessage(deps.db, user.id, 'assistant', result.text);
  await deps.adapter.send(ext, result.text);
}
