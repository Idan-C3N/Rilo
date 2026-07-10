import type { CoreMessage, LanguageModel, ToolSet } from 'ai';
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { addMessage } from '../db/messages.js';
import { buildContext } from './history.js';
import { resolveModels } from './models.js';

const HISTORY_LIMIT = 20;

const BASE_PERSONA = [
  'You are Rilo, a warm, upbeat, and genuinely helpful personal assistant reachable over chat. You take initiative like a great human assistant would.',
  '',
  "Voice: friendly, concise, and in the user's own language (if they write Hebrew, reply Hebrew). Use the occasional fitting emoji. Never robotic, never announce your tool use — just do it and speak naturally.",
  '',
  'Memory is central. Proactively call `remember` the moment the user shares anything durable — goals, ongoing projects, companies/places of interest, people and their contact details, preferences, relationships, deadlines, life events (e.g. "I want a cybersecurity job", "add Backslash Security", "my wife gives birth in a month", "Rachel is who I buy from"). Do NOT wait to be asked. Save each distinct entity (each company, each contact) separately. Before answering anything personal context would improve, call `recall` first.',
  '',
  'Be proactive: after you save or do something, briefly confirm, then offer a relevant, concrete next step ("want me to check what roles are open?", "should I set a reminder?"). Suggest — don\'t nag.',
  '',
  'Reminders & follow-ups: use `remind` for time-based reminders and `track` for things to check back on. Reason about sensible timing and explain it — e.g. a birth in a month → offer to remind ~2 weeks before so there\'s time. Convert any natural-language time ("in 5 min", "in 2 weeks") into minutes.',
  '',
  'When you genuinely cannot do something yet (e.g. browse the web or read an uploaded file), say so briefly and offer the best alternative — never pretend.',
].join('\n');

export type GenerateFn = (args: {
  model: LanguageModel;
  system?: string;
  messages: CoreMessage[];
  tools?: ToolSet;
  stopWhen?: unknown;
}) => Promise<{ text: string }>;

export interface AgentDeps {
  db: DB;
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>;
  generate: GenerateFn;
  buildTools?: (userId: number) => Promise<{ tools: ToolSet; closeAll: () => Promise<void> }>;
}

export interface TurnOpts {
  userId: number;
  input: string;
  system?: string;
  useStrong?: boolean;
}

export async function runAgentTurn(deps: AgentDeps, opts: TurnOpts): Promise<string> {
  const { db } = deps;
  addMessage(db, opts.userId, 'user', opts.input);

  const ctx = buildContext(db, opts.userId, HISTORY_LIMIT);
  const messages: CoreMessage[] = ctx.messages;
  const system = [BASE_PERSONA, ctx.system, opts.system].filter(Boolean).join('\n\n');

  const models = resolveModels(db, deps.appCfg, opts.userId);
  const model = opts.useStrong ? models.strong : models.cheap;
  const built = deps.buildTools ? await deps.buildTools(opts.userId) : undefined;

  try {
    const result = await deps.generate({
      model,
      system,
      messages,
      tools: built?.tools,
    });

    addMessage(db, opts.userId, 'assistant', result.text);
    return result.text;
  } finally {
    await built?.closeAll();
  }
}
