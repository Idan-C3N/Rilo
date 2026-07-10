import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import type { GenerateFn } from './core.js';
import { resolveModels } from './models.js';

const SUMMARY_TRIGGER = 30;

export interface SummarizeDeps {
  db: DB;
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>;
  generate: GenerateFn;
}

export function getSummary(db: DB, userId: number): { summary: string; last_summarized_msg_id: number } {
  const row = db.prepare('SELECT summary, last_summarized_msg_id FROM summaries WHERE user_id = ?').get(userId) as
    | { summary: string; last_summarized_msg_id: number }
    | undefined;
  return row ?? { summary: '', last_summarized_msg_id: 0 };
}

export async function maybeSummarize(deps: SummarizeDeps, userId: number): Promise<void> {
  const { db } = deps;
  const { summary, last_summarized_msg_id } = getSummary(db, userId);
  const unsummarized = db
    .prepare('SELECT * FROM messages WHERE user_id = ? AND id > ? ORDER BY id ASC')
    .all(userId, last_summarized_msg_id) as { id: number; role: string; content: string }[];
  if (unsummarized.length <= SUMMARY_TRIGGER) return;

  const half = Math.floor(unsummarized.length / 2);
  const toFold = unsummarized.slice(0, half);
  const transcript = toFold.map((m) => `${m.role}: ${m.content}`).join('\n');
  const models = resolveModels(db, deps.appCfg, userId);
  const result = await deps.generate({
    model: models.cheap,
    system:
      'Update the running summary of this conversation. Keep durable facts, ongoing tasks, and context. Be concise.',
    messages: [
      { role: 'user', content: `Existing summary:\n${summary || '(none)'}\n\nNew messages to fold in:\n${transcript}` },
    ],
  });
  const newPointer = toFold[toFold.length - 1]!.id;
  db.prepare(
    `INSERT INTO summaries (user_id, summary, last_summarized_msg_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET summary = excluded.summary, last_summarized_msg_id = excluded.last_summarized_msg_id`,
  ).run(userId, result.text, newPointer);
}
