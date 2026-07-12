import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, openDb } from '../../src/db/db.js';

describe('embedding column migration', () => {
  it('adds embedding to a pre-existing memory table', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER);
      CREATE TABLE memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        mkey TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL
      );`);
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('embedding');
  });

  it('fresh DB already has embedding', () => {
    const cols = (openDb(':memory:').prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('embedding');
  });
});
