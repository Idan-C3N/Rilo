import { pino } from 'pino';

// Structured JSON logger. One line per event → `docker compose logs app | jq`.
// `silent` under vitest so tests don't spew. LOG_LEVEL=debug surfaces message
// content + full context; default `info` logs lengths/metadata only (PII-safe).
export const REDACT_PATHS = [
  'token', 'phone', 'refresh_token', 'authorization', 'openrouterKey', 'creds', 'key', 'api_key',
  '*.token', '*.phone', '*.refresh_token', '*.authorization', '*.openrouterKey', '*.creds', '*.key', '*.api_key',
];

export const log = pino({
  level: process.env.LOG_LEVEL ?? (process.env.VITEST ? 'silent' : 'info'),
  redact: {
    paths: REDACT_PATHS,
    censor: '[redacted]',
  },
});

export type Log = typeof log;

/**
 * Summarize AI-SDK `steps` into `[{ name, argKeys }]` for logging. We record
 * tool NAMES and argument KEYS only — never argument values (they carry PII).
 * Defensive: tolerates undefined/malformed input and returns [].
 */
export function summarizeSteps(steps: unknown): { name: string; argKeys: string[] }[] {
  if (!Array.isArray(steps)) return [];
  const out: { name: string; argKeys: string[] }[] = [];
  for (const step of steps) {
    const calls = (step as { toolCalls?: unknown })?.toolCalls;
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      const call = c as { toolName?: unknown; input?: unknown };
      out.push({
        name: String(call?.toolName ?? 'unknown'),
        argKeys: call?.input && typeof call.input === 'object' ? Object.keys(call.input as object) : [],
      });
    }
  }
  return out;
}
