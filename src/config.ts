export interface AppConfig {
  dbPath: string;
  encKey: string;
  telegramToken: string;
  openrouterKeyFallback?: string;
  webPort: number;
  webBaseUrl: string;
  heartbeatDefaultMin: number;
  tavilyApiKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const webPort = Number(env.WEB_PORT ?? '8080');
  return {
    dbPath: req(env, 'DB_PATH'),
    encKey: req(env, 'ENC_KEY'),
    telegramToken: req(env, 'TELEGRAM_TOKEN'),
    openrouterKeyFallback: env.OPENROUTER_KEY || undefined,
    webPort,
    webBaseUrl: env.WEB_BASE_URL || `http://localhost:${webPort}`,
    heartbeatDefaultMin: Number(env.HEARTBEAT_DEFAULT_MIN ?? '30'),
    tavilyApiKey: env.TAVILY_API_KEY || undefined,
    googleClientId: env.GOOGLE_CLIENT_ID || undefined,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
  };
}
