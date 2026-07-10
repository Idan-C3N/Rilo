export interface AppConfig {
  dbPath: string;
  encKey: string;
  telegramToken: string;
  openrouterKeyFallback?: string;
  webPort: number;
  heartbeatDefaultMin: number;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    dbPath: req(env, 'DB_PATH'),
    encKey: req(env, 'ENC_KEY'),
    telegramToken: req(env, 'TELEGRAM_TOKEN'),
    openrouterKeyFallback: env.OPENROUTER_KEY || undefined,
    webPort: Number(env.WEB_PORT ?? '8080'),
    heartbeatDefaultMin: Number(env.HEARTBEAT_DEFAULT_MIN ?? '30'),
  };
}
