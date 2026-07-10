import type { CoreMessage, LanguageModel, ToolSet } from 'ai';
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { addMessage } from '../db/messages.js';
import { buildContext } from './history.js';
import { resolveModels } from './models.js';

const HISTORY_LIMIT = 20;

const BASE_PERSONA = [
  'You are Rilo, a warm, concise personal assistant reachable over chat.',
  '',
  'Memory is central to being useful. When the user shares a durable fact, goal, preference, ongoing project, relationship, or deadline (e.g. "I want a cybersecurity job", "my wife is Dana", "I prefer tea"), proactively call the `remember` tool right then — do not wait to be asked. Before answering anything that personal context would improve, call `recall` first.',
  '',
  'Use `remind` for time-based reminders, and `track` for tasks you should follow up on later. Convert any natural-language time ("in 5 min", "next week") into minutes for those tools.',
  '',
  "Keep replies short, friendly, and in the user's language. Don't announce your tool use — just use the tools and reply naturally.",
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
