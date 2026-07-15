import { describe, it, expect } from 'vitest';
import { summarizeSteps, REDACT_PATHS } from '../src/log.js';

describe('REDACT_PATHS', () => {
  it('redacts credential-bearing keys', () => {
    for (const k of ['creds', '*.creds', 'key', 'api_key']) expect(REDACT_PATHS).toContain(k);
  });
});

describe('summarizeSteps', () => {
  it('extracts tool names + arg keys (never values)', () => {
    const steps = [
      { toolCalls: [{ toolName: 'remember', input: { text: 'secret', key: 'k' } }] },
      { toolCalls: [{ toolName: 'recall', input: { query: 'q' } }] },
    ];
    expect(summarizeSteps(steps)).toEqual([
      { name: 'remember', argKeys: ['text', 'key'] },
      { name: 'recall', argKeys: ['query'] },
    ]);
  });

  it('handles multiple tool calls in one step', () => {
    const steps = [{ toolCalls: [{ toolName: 'a', input: {} }, { toolName: 'b', input: { x: 1 } }] }];
    expect(summarizeSteps(steps)).toEqual([
      { name: 'a', argKeys: [] },
      { name: 'b', argKeys: ['x'] },
    ]);
  });

  it('returns [] for undefined or malformed input', () => {
    expect(summarizeSteps(undefined)).toEqual([]);
    expect(summarizeSteps([{}, { toolCalls: 'nope' }])).toEqual([]);
  });
});
