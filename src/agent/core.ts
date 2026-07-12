import type { CoreMessage, LanguageModel, ToolSet } from 'ai';
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { addMessage } from '../db/messages.js';
import { buildContext } from './history.js';
import { resolveModels } from './models.js';
import { log, summarizeSteps } from '../log.js';

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

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type GenerateFn = (args: {
  model: LanguageModel;
  system?: string;
  messages: CoreMessage[];
  tools?: ToolSet;
  stopWhen?: unknown;
}) => Promise<{ text: string; usage?: LlmUsage; steps?: unknown }>;

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
  /** Correlation id shared across all log lines for this message. */
  turnId?: string;
}

export async function runAgentTurn(deps: AgentDeps, opts: TurnOpts): Promise<string> {
  const { db } = deps;
  const lg = log.child({ turnId: opts.turnId, userId: opts.userId });
  addMessage(db, opts.userId, 'user', opts.input);

  const ctx = buildContext(db, opts.userId, HISTORY_LIMIT);
  const messages: CoreMessage[] = ctx.messages;
  const system = [BASE_PERSONA, ctx.system, opts.system].filter(Boolean).join('\n\n');

  const models = resolveModels(db, deps.appCfg, opts.userId);
  const model = opts.useStrong ? models.strong : models.cheap;
  const modelId = (model as { modelId?: string })?.modelId;
  const built = deps.buildTools ? await deps.buildTools(opts.userId) : undefined;
  lg.info(
    { event: 'turn.start', model: modelId, useStrong: !!opts.useStrong, tools: built ? Object.keys(built.tools).length : 0 },
    'turn start',
  );

  const t0 = Date.now();
  try {
    const result = await deps.generate({
      model,
      system,
      messages,
      tools: built?.tools,
    });

    lg.info(
      {
        event: 'llm.done',
        ms: Date.now() - t0,
        usage: result.usage,
        tools: summarizeSteps(result.steps),
        chars: result.text.length,
      },
      'llm done',
    );

    addMessage(db, opts.userId, 'assistant', result.text);
    return result.text;
  } catch (err) {
    lg.error({ event: 'turn.error', ms: Date.now() - t0, model: modelId, err }, 'llm/tool failed');
    throw err;
  } finally {
    await built?.closeAll();
  }
}
