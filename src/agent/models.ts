import type { LanguageModel } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { DB } from '../db/db.js';
import type { AppConfig } from '../config.js';
import { getConfig, getOpenrouterKey } from '../db/config.js';

export function resolveModels(
  db: DB,
  appCfg: Pick<AppConfig, 'openrouterKeyFallback'>,
  userId: number,
): { cheap: LanguageModel; strong: LanguageModel } {
  const apiKey = getOpenrouterKey(db, userId) ?? appCfg.openrouterKeyFallback;
  if (!apiKey) {
    throw new Error('No OpenRouter key for user and no fallback configured');
  }
  const openrouter = createOpenRouter({ apiKey });
  const cfg = getConfig(db, userId);
  return {
    cheap: openrouter.chat(cfg.cheap_model),
    strong: openrouter.chat(cfg.strong_model),
  };
}
