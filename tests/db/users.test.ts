import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/db/db.js';
import { createUser, getUserByTelegramId, isAllowlisted, setAllowlisted } from '../../src/db/users.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('users repo', () => {
  it('creates a user, not allowlisted by default, with a config row', () => {
    const u = createUser(db, { telegram_id: '123', name: 'Ann', heartbeat_interval_min: 30 });
    expect(u.id).toBeGreaterThan(0);
    expect(isAllowlisted(db, '123')).toBe(false);
    const cfg = db.prepare('SELECT * FROM config WHERE user_id=?').get(u.id) as any;
    expect(cfg.cheap_model).toContain('haiku');
  });

  it('allowlists a user', () => {
    const u = createUser(db, { telegram_id: '9', name: 'B', heartbeat_interval_min: 30 });
    setAllowlisted(db, u.id, true);
    expect(isAllowlisted(db, '9')).toBe(true);
  });

  it('finds by telegram id', () => {
    createUser(db, { telegram_id: 'tg', name: 'C', heartbeat_interval_min: 15 });
    expect(getUserByTelegramId(db, 'tg')?.name).toBe('C');
    expect(getUserByTelegramId(db, 'nope')).toBeUndefined();
  });
});
