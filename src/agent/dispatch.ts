import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import type { InboundMessage, ChannelAdapter, TypingController } from '../channels/adapter.js';
import { getUserByIdentity, createUserWithIdentity, isAllowlisted } from '../db/users.js';
import type { runAgentTurn, GenerateFn } from './core.js';

export const NOT_AUTHORIZED =
  'You are not authorized to use this assistant. Ask the owner to allowlist you.';

export interface DispatchDeps {
  db: DB;
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>;
  adapter: Pick<ChannelAdapter, 'send'> & { typingFor(id: string): TypingController };
  runTurn: typeof runAgentTurn;
  generate: GenerateFn;
  buildTools?: (userId: number) => Promise<import('ai').ToolSet>;
  heartbeatDefaultMin: number;
}

export async function handleInbound(deps: DispatchDeps, m: InboundMessage): Promise<void> {
  const { db } = deps;
  let user = getUserByIdentity(db, m.channel, m.channelUserId);
  if (!user) {
    user = createUserWithIdentity(db, {
      channel: m.channel,
      externalId: m.channelUserId,
      name: m.name,
      heartbeat_interval_min: deps.heartbeatDefaultMin,
    });
  }
  if (!isAllowlisted(db, user.id)) {
    await deps.adapter.send(m.channelUserId, NOT_AUTHORIZED);
    return;
  }
  const typing = deps.adapter.typingFor(m.channelUserId);
  typing.start();
  try {
    const reply = await deps.runTurn(
      { db, appCfg: deps.appCfg, generate: deps.generate, buildTools: deps.buildTools },
      { userId: user.id, input: m.text },
    );
    await deps.adapter.send(m.channelUserId, reply);
  } finally {
    typing.stop();
  }
}
