import type { CoreMessage } from 'ai';
import type { DB } from '../db/db.js';
import { recentMessages } from '../db/messages.js';
import { getSummary } from './summarize.js';

export function buildContext(
  db: DB,
  userId: number,
  recentLimit: number,
): { system?: string; messages: CoreMessage[] } {
  const { summary } = getSummary(db, userId);
  const msgs = recentMessages(db, userId, recentLimit).map((m) => ({
    role: m.role === 'system' ? 'system' : m.role,
    content: m.content,
  })) as CoreMessage[];
  return {
    system: summary ? `Conversation summary so far:\n${summary}` : undefined,
    messages: msgs,
  };
}
