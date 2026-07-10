import type { CoreMessage, LanguageModel, ToolSet } from 'ai';
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { addMessage } from '../db/messages.js';
import { buildContext } from './history.js';
import { resolveModels } from './models.js';

const HISTORY_LIMIT = 20;

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
  const system = [opts.system, ctx.system].filter(Boolean).join('\n\n') || undefined;

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
