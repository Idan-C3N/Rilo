import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type DB = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): DB {
  // Ensure the parent directory exists (`:memory:` has no dirname to create).
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
}

// Idempotent column migrations for DBs created before a column existed.
// `CREATE TABLE IF NOT EXISTS` never alters an existing table, so new columns
// on existing tables need an explicit ALTER guarded by a presence check.
export function migrate(db: DB): void {
  const userCols = new Set(
    (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!userCols.has('is_owner')) {
    db.exec('ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0');
  }
  const memCols = new Set(
    (db.prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!memCols.has('embedding')) {
    db.exec('ALTER TABLE memory ADD COLUMN embedding BLOB');
  }
  if (!memCols.has('space_id')) {
    db.exec('ALTER TABLE memory ADD COLUMN space_id INTEGER REFERENCES spaces(id)');
  }
  const jobCols = new Set(
    (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!jobCols.has('recurrence')) {
    db.exec('ALTER TABLE jobs ADD COLUMN recurrence TEXT');
  }
  if (!jobCols.has('recurrence_until')) {
    db.exec('ALTER TABLE jobs ADD COLUMN recurrence_until INTEGER');
  }
  if (!jobCols.has('recurrence_count')) {
    db.exec('ALTER TABLE jobs ADD COLUMN recurrence_count INTEGER');
  }
}
