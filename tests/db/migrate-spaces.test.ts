import { describe, it, expect } from 'vitest';
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
});
