import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DB_PATH: '/tmp/x.db',
  ENC_KEY: 'a'.repeat(44),
  TELEGRAM_TOKEN: 'tok',
  WEB_PORT: '8080',
  HEARTBEAT_DEFAULT_MIN: '30',
};

describe('loadConfig', () => {
  it('parses required vars with defaults', () => {
    const c = loadConfig(base as any);
    expect(c.dbPath).toBe('/tmp/x.db');
    expect(c.webPort).toBe(8080);
    expect(c.heartbeatDefaultMin).toBe(30);
  });

  it('throws when a required var is missing', () => {
    const { TELEGRAM_TOKEN, ...missing } = base;
    expect(() => loadConfig(missing as any)).toThrow(/TELEGRAM_TOKEN/);
  });

  it('defaults model family to anthropic/ and honors override', () => {
    expect(loadConfig(base as any).defaultModelFamily).toBe('anthropic/');
    expect(loadConfig({ ...base, DEFAULT_MODEL_FAMILY: 'openai/' } as any).defaultModelFamily).toBe('openai/');
  });
});
