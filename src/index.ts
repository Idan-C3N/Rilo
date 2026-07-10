import { generateText, stepCountIs, type CoreMessage } from 'ai';
import { loadConfig } from './config.js';
import { initCrypto } from './crypto/encryption.js';
import { openDb } from './db/db.js';
import { createTelegramAdapter } from './channels/telegram.js';
import { handleInbound } from './agent/dispatch.js';
import { runAgentTurn } from './agent/core.js';
import type { GenerateFn } from './agent/core.js';
// TODO(Task 12): wire real tool building once src/agent/tools/index.ts exists.
// import { buildToolsFor } from './agent/tools/index.js';
// TODO(Task 13/19): wire scheduler once src/scheduler/scheduler.ts exists.
// import { startScheduler } from './scheduler/scheduler.js';
// TODO(Task 25): wire web server once src/web/server.ts exists.
// import { startWeb } from './web/server.js';

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

// TODO(Task 12): replace with real buildTools = (userId) => buildToolsFor({ db, userId });
const buildTools = undefined;

adapter.onMessage((m) =>
  handleInbound(
    { db, appCfg, adapter, runTurn: runAgentTurn, generate, buildTools, heartbeatDefaultMin: appCfg.heartbeatDefaultMin },
    m,
  ),
);

// TODO(Task 13/19): startScheduler({ db, appCfg, adapter, generate, channel: adapter.channel });
// TODO(Task 25): await startWeb({ db, appCfg, adapter });
adapter.start();
console.log('personal-agent running');
