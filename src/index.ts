import { generateText, stepCountIs, type CoreMessage } from 'ai';
import { loadConfig } from './config.js';
import { initCrypto } from './crypto/encryption.js';
import { openDb } from './db/db.js';
import { createTelegramAdapter } from './channels/telegram.js';
import { handleInbound } from './agent/dispatch.js';
import { ensureOwner } from './db/users.js';
import { runAgentTurn } from './agent/core.js';
import type { GenerateFn } from './agent/core.js';
import { maybeSummarize } from './agent/summarize.js';
import { startScheduler } from './scheduler/scheduler.js';
import { fireReminder } from './scheduler/fire.js';
import { buildToolsFor } from './agent/tools/index.js';
import { selectSearchBackend } from './agent/tools/websearch.js';
import { fireHeartbeat, seedHeartbeats } from './scheduler/heartbeat.js';
import { startWeb } from './web/server.js';
import { resolveDefaultModels } from './openrouter/catalog.js';

const appCfg = loadConfig(process.env);
await initCrypto(appCfg.encKey);
const db = openDb(appCfg.dbPath);

const generate: GenerateFn = async (args) =>
  generateText({
    model: args.model,
    system: args.system,
    messages: args.messages as CoreMessage[],
    tools: args.tools,
    stopWhen: stepCountIs(8),
  });

const adapter = createTelegramAdapter({ token: appCfg.telegramToken });

// Seed the owner from OWNER_TELEGRAM_ID (idempotent). Without an owner nobody
// can approve access requests, so warn loudly if it's unset.
if (appCfg.ownerTelegramId) {
  ensureOwner(db, appCfg.ownerTelegramId);
} else {
  console.warn('OWNER_TELEGRAM_ID is unset — nobody can approve access requests.');
}

// Fetch the bot username so registration deep links resolve. Best-effort: if
// Telegram is unreachable at boot, links degrade gracefully (empty username).
try {
  await adapter.ensureBotUsername();
} catch (err) {
  console.warn('could not fetch bot username (registration links may be incomplete):', err);
}

const google =
  appCfg.googleClientId && appCfg.googleClientSecret
    ? { clientId: appCfg.googleClientId, clientSecret: appCfg.googleClientSecret }
    : undefined;
const search = selectSearchBackend(appCfg);
const buildTools = (userId: number) =>
  buildToolsFor({ db, userId, search, google });

adapter.onMessage((m) =>
  handleInbound(
    {
      db,
      appCfg,
      adapter,
      runTurn: runAgentTurn,
      generate,
      buildTools,
      heartbeatDefaultMin: appCfg.heartbeatDefaultMin,
      maybeSummarize,
      webBaseUrl: appCfg.webBaseUrl,
      ownerTelegramId: appCfg.ownerTelegramId,
      resolveDefaultModels: () => resolveDefaultModels(appCfg.defaultModelFamily),
    },
    m,
  ),
);

seedHeartbeats(db, appCfg);
startScheduler({ db, appCfg, adapter, generate, channel: adapter.channel, fireReminder, fireHeartbeat });
await startWeb({
  db,
  appCfg,
  port: appCfg.webPort,
  registrationLink: (code) => adapter.registrationLink(code),
  notify: (channelUserId, text) => adapter.send(channelUserId, text),
});

// grammy's start() runs long polling; if the token is bad or Telegram is
// unreachable it rejects (e.g. getMe 401). Surface it clearly instead of a
// bare unhandled rejection — the scheduler + web UI keep running regardless.
Promise.resolve(adapter.start()).catch((err) => {
  console.error('Telegram adapter failed to start (check TELEGRAM_TOKEN / connectivity):', err);
});

console.log('personal-agent running (web UI + scheduler up; Telegram connecting…)');
