import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import type { InboundMessage, ChannelAdapter, TypingController } from '../channels/adapter.js';
import {
  getUserByIdentity,
  createUserWithIdentity,
  isAllowlisted,
  isOwner,
} from '../db/users.js';
import {
  findByCode,
  bindRequester,
  findAwaitingContact,
  markPendingApproval,
  findPendingByUserId,
  approveUser,
  denyUser,
  phoneMatches,
  normalizePhone,
} from '../db/registrations.js';
import { startLogin } from '../db/sessions.js';
import { setModels } from '../db/config.js';
import type { runAgentTurn, GenerateFn } from './core.js';
import { maybeSummarize } from './summarize.js';

export const NOT_AUTHORIZED =
  'You are not authorized to use this assistant. Ask the owner to allowlist you.';

export interface DispatchDeps {
  db: DB;
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>;
  adapter: Pick<ChannelAdapter, 'send' | 'requestContact'> & { typingFor(id: string): TypingController };
  runTurn: typeof runAgentTurn;
  generate: GenerateFn;
  buildTools?: (userId: number) => Promise<{ tools: import('ai').ToolSet; closeAll: () => Promise<void> }>;
  heartbeatDefaultMin: number;
  maybeSummarize?: typeof maybeSummarize;
  webBaseUrl: string;
  /** Telegram id of the owner; owner receives access-request pings. */
  ownerTelegramId?: string;
  resolveDefaultModels?: () => Promise<{ cheap_model: string; strong_model: string } | undefined>;
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
    // Best-effort: seed model defaults from the live catalog. Never let a
    // catalog failure break onboarding — the SQL defaults stand if it throws.
    try {
      const seeded = await deps.resolveDefaultModels?.();
      if (seeded) setModels(db, user.id, seeded);
    } catch {
      // ignore — SQL column defaults remain
    }
  }

  const text = m.text.trim();

  // 1. Registration deep link: /start <code> binds the requester and asks them
  //    to share their contact so we can verify the phone.
  const startMatch = text.match(/^\/start\s+(\S+)$/);
  if (startMatch) {
    const code = startMatch[1]!;
    const reg = findByCode(db, code);
    if (!reg || reg.expires_at < Date.now() || reg.status !== 'awaiting_start') {
      await deps.adapter.send(m.channelUserId, 'That registration link has expired. Please register again.');
      return;
    }
    bindRequester(db, reg.id, m.channelUserId, user.id);
    await deps.adapter.requestContact(
      m.channelUserId,
      'Tap the button below to share your number and finish verifying.',
    );
    return;
  }

  // 2. Shared contact: verify the phone against the pending registration.
  if (m.contact) {
    const reg = findAwaitingContact(db, m.channel, m.channelUserId);
    if (!reg) {
      await deps.adapter.send(
        m.channelUserId,
        `Please register first at ${deps.webBaseUrl}/register`,
      );
      return;
    }
    if (phoneMatches(m.contact.phone, reg.phone)) {
      markPendingApproval(db, reg.id);
      if (deps.ownerTelegramId) {
        const last4 = normalizePhone(reg.phone).slice(-4);
        await deps.adapter.send(
          deps.ownerTelegramId,
          `📥 ${reg.name} (…${last4}) wants access.\n/approve ${reg.user_id}   /deny ${reg.user_id}`,
        );
      }
      await deps.adapter.send(
        m.channelUserId,
        "Request sent — you'll get a message here when you're approved.",
      );
    } else {
      await deps.adapter.send(m.channelUserId, "That number doesn't match your registration.");
    }
    return;
  }

  // 3. Owner approval commands. Catch the command word regardless of args so a
  //    bare `/approve` gets a usage hint instead of leaking to the LLM.
  const approveMatch = text.match(/^\/(approve|deny)\b\s*(\d+)?/i);
  if (approveMatch && isOwner(db, user.id)) {
    const action = approveMatch[1]!.toLowerCase();
    if (!approveMatch[2]) {
      await deps.adapter.send(m.channelUserId, `Usage: /${action} <user id>`);
      return;
    }
    const targetUserId = Number(approveMatch[2]);
    const reg = action === 'approve' ? approveUser(db, targetUserId) : denyUser(db, targetUserId);
    if (!reg) {
      await deps.adapter.send(m.channelUserId, `No pending request for user ${targetUserId}.`);
      return;
    }
    if (action === 'approve') {
      if (reg.channel_user_id) {
        await deps.adapter.send(reg.channel_user_id, "You're in! Send /login to get started.");
      }
      await deps.adapter.send(m.channelUserId, `Approved ${reg.name} (user ${targetUserId}).`);
    } else {
      if (reg.channel_user_id) {
        await deps.adapter.send(reg.channel_user_id, 'Your access request was declined.');
      }
      await deps.adapter.send(m.channelUserId, `Denied ${reg.name} (user ${targetUserId}).`);
    }
    return;
  }

  // 4. Allowlist gate.
  if (!isAllowlisted(db, user.id)) {
    if (findPendingByUserId(db, user.id)) {
      await deps.adapter.send(
        m.channelUserId,
        "Your request is awaiting approval — you'll hear from us soon.",
      );
    } else {
      await deps.adapter.send(
        m.channelUserId,
        `${NOT_AUTHORIZED}\n\nWant access? Register here: ${deps.webBaseUrl}/register`,
      );
    }
    return;
  }

  // 5. Normal handling — magic-link login (#11).
  if (text === '/login') {
    const { token } = startLogin(db, user.id);
    const url = `${deps.webBaseUrl}/login?token=${token}`;
    await deps.adapter.send(
      m.channelUserId,
      `Log in: ${url}\n\n(link expires in 10 minutes, one-time use)`,
      { disableLinkPreview: true },
    );
    return;
  }
  const typing = deps.adapter.typingFor(m.channelUserId);
  typing.start();
  try {
    const reply = await deps.runTurn(
      { db, appCfg: deps.appCfg, generate: deps.generate, buildTools: deps.buildTools },
      { userId: user.id, input: m.text, useStrong: true },
    );
    await deps.adapter.send(m.channelUserId, reply);
    try {
      await (deps.maybeSummarize ?? maybeSummarize)(
        { db, appCfg: deps.appCfg, generate: deps.generate },
        user.id,
      );
    } catch {
      // summarization failures must never break a reply
    }
  } finally {
    typing.stop();
  }
}
