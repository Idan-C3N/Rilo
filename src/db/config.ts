import type { DB } from './db.js';
import { encrypt, decrypt } from '../crypto/encryption.js';

export interface UserConfig {
  user_id: number;
  cheap_model: string;
  strong_model: string;
  settings: Record<string, unknown>;
}

interface Row {
  user_id: number;
  cheap_model: string;
  strong_model: string;
  openrouter_key_enc: string | null;
  settings_json: string;
}

export function getConfig(db: DB, userId: number): UserConfig {
  const r = db.prepare('SELECT * FROM config WHERE user_id = ?').get(userId) as Row | undefined;
  if (!r) throw new Error(`no config for user ${userId}`);
  return {
    user_id: r.user_id,
    cheap_model: r.cheap_model,
    strong_model: r.strong_model,
    settings: JSON.parse(r.settings_json),
  };
}

export function setModels(
  db: DB,
  userId: number,
  m: { cheap_model?: string; strong_model?: string },
): void {
  const cur = getConfig(db, userId);
  db.prepare('UPDATE config SET cheap_model = ?, strong_model = ? WHERE user_id = ?').run(
    m.cheap_model ?? cur.cheap_model,
    m.strong_model ?? cur.strong_model,
    userId,
  );
}

export function setOpenrouterKey(db: DB, userId: number, plainKey: string): void {
  db.prepare('UPDATE config SET openrouter_key_enc = ? WHERE user_id = ?').run(
    encrypt(plainKey),
    userId,
  );
}

export function getOpenrouterKey(db: DB, userId: number): string | undefined {
  const r = db.prepare('SELECT openrouter_key_enc FROM config WHERE user_id = ?').get(userId) as
    | { openrouter_key_enc: string | null }
    | undefined;
  if (!r || !r.openrouter_key_enc) return undefined;
  return decrypt(r.openrouter_key_enc);
}
