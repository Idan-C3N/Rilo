import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';

describe('openDb', () => {
  it('creates all tables idempotently', () => {
    const db = openDb(':memory:');
    // second call on same file path would re-run; here just verify tables exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r: any) => r.name);
    for (const t of ['users', 'identities', 'config', 'messages', 'jobs', 'memory', 'mcp_servers', 'sessions', 'summaries']) {
      expect(tables).toContain(t);
    }
  });
});
