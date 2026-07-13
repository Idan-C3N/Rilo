import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate, openDb } from '../../src/db/db.js';

describe('spaces migration', () => {
  it('adds space_id to a pre-existing memory table', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER);
      CREATE TABLE memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        mkey TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL, embedding BLOB
      );`);
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('space_id');
  });

  it('fresh DB has spaces tables and memory.space_id', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('space_id');
    // tables exist (querying an absent table throws)
    expect(() => db.prepare('SELECT * FROM spaces').all()).not.toThrow();
    expect(() => db.prepare('SELECT * FROM space_members').all()).not.toThrow();
  });

  // Regression for the prod crash: openDb runs schema.sql (which defined
  // `CREATE INDEX idx_memory_space ON memory(space_id)`) BEFORE migrate() adds
  // the space_id column. On a fresh DB the column comes from CREATE TABLE so it
  // works, but on a pre-existing memory table (production) the index statement
  // hit "no such column: space_id" and the app crash-looped. Uses a file DB so
  // the legacy state persists across the reopen (:memory: can't be reopened).
  it('openDb succeeds on a legacy DB whose memory table predates space_id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rilo-mig-'));
    const path = join(dir, 'legacy.db');
    try {
      const seed = new Database(path);
      seed.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER);
        CREATE TABLE memory (
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
          mkey TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL, embedding BLOB
        );`);
      seed.close();

      // openDb execs schema.sql then migrate() — must not throw on the legacy DB.
      const db = openDb(path);
      const cols = (db.prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain('space_id');
      const idx = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_space'")
        .get();
      expect(idx).toBeTruthy();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
