import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, openDb } from '../../src/db/db.js';
import { createUserWithIdentity } from '../../src/db/users.js';
import { addJob, dueJobs } from '../../src/db/jobs.js';

describe('attempts migration', () => {
  it('adds attempts to a pre-existing jobs table', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER);
      CREATE TABLE memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        mkey TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL, embedding BLOB
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        type TEXT NOT NULL, fire_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
      );`);
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('attempts');
  });

  it('fresh DB jobs default attempts to 0', () => {
    const db = openDb(':memory:');
    const uid = createUserWithIdentity(db, { channel: 'telegram', externalId: 'ta', heartbeat_interval_min: 30 }).id;
    const id = addJob(db, { userId: uid, type: 'reminder', fireAt: 10, payload: {} });
    const job = dueJobs(db, 100).find((j) => j.id === id)!;
    expect(job.attempts).toBe(0);
  });
});
