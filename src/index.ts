import { generateText, stepCountIs, type CoreMessage } from 'ai';
import { loadConfig } from './config.js';
import { initCrypto } from './crypto/encryption.js';
import { openDb } from './db/db.js';
import { createTelegramAdapter } from './channels/telegram.js';
import { handleInbound } from './agent/dispatch.js';
import { runAgentTurn } from './agent/core.js';
import type { GenerateFn } from './agent/core.js';
import { maybeSummarize } from './agent/summarize.js';
import { startScheduler } from './scheduler/scheduler.js';
import { fireReminder } from './scheduler/fire.js';
import { buildToolsFor } from './agent/tools/index.js';
import { fireHeartbeat, seedHeartbeats } from './scheduler/heartbeat.js';
import { startWeb } from './web/server.js';

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

const buildTools = (userId: number) => buildToolsFor({ db, userId });

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
    },
    m,
  ),
);

seedHeartbeats(db, appCfg);
startScheduler({ db, appCfg, adapter, generate, channel: adapter.channel, fireReminder, fireHeartbeat });
await startWeb({ db, appCfg, port: appCfg.webPort });
adapter.start();
console.log('personal-agent running');
