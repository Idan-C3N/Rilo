CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  tz TEXT NOT NULL DEFAULT 'UTC',
  quiet_start INTEGER NOT NULL DEFAULT 22,   -- hour 0-23 local
  quiet_end INTEGER NOT NULL DEFAULT 8,
  heartbeat_interval_min INTEGER NOT NULL DEFAULT 30,
  allowlisted INTEGER NOT NULL DEFAULT 0,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Normalized per-channel identity. A user has one row per messaging platform
-- they've talked to us on; adding a new platform needs zero schema change.
CREATE TABLE IF NOT EXISTS identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(channel, external_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_lookup ON identities(channel, external_id);

CREATE TABLE IF NOT EXISTS config (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cheap_model TEXT NOT NULL DEFAULT 'anthropic/claude-haiku-4.5',
  strong_model TEXT NOT NULL DEFAULT 'anthropic/claude-sonnet-5',
  openrouter_key_enc TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,           -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);

CREATE TABLE IF NOT EXISTS summaries (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  last_summarized_msg_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,           -- 'reminder' | 'followup' | 'heartbeat'
  fire_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'done' | 'cancelled'
  created_at INTEGER NOT NULL,
  recurrence TEXT,              -- cron expression; NULL = one-shot
  recurrence_until INTEGER,     -- epoch ms; retire once next occurrence would pass this
  recurrence_count INTEGER      -- remaining fires; retire at 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, fire_at);

CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mkey TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  embedding BLOB,
  space_id INTEGER REFERENCES spaces(id)
);
CREATE INDEX IF NOT EXISTS idx_memory_user ON memory(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_space ON memory(space_id);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,      -- 'stdio' | 'http' | 'sse'
  command TEXT,                 -- stdio: executable
  args_json TEXT NOT NULL DEFAULT '[]',
  url TEXT,                     -- http/sse
  creds_enc TEXT,               -- encrypted JSON (headers/env)
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_mcp_user ON mcp_servers(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT,                    -- pending magic code; NULL once consumed
  verified INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

-- Per-user OAuth tokens for native service integrations (e.g. Google).
-- token_enc is an encrypted refresh token. New table → applies cleanly to an
-- existing DB on next boot (no ALTER migration needed).
CREATE TABLE IF NOT EXISTS oauth_tokens (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,       -- 'google'
  token_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- Self-service onboarding: a stranger registers on the web, proves their phone
-- via a channel contact-share, and the owner approves. One row per attempt.
-- New table → applies cleanly to an existing DB on next boot.
CREATE TABLE IF NOT EXISTS pending_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,             -- normalized (digits only)
  code TEXT NOT NULL UNIQUE,       -- unguessable; used in the deep link
  channel TEXT NOT NULL DEFAULT 'telegram',
  channel_user_id TEXT,           -- null until /start <code> binds the requester
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- null until bound
  status TEXT NOT NULL DEFAULT 'awaiting_start',
    -- awaiting_start -> awaiting_contact -> pending_approval -> approved | denied
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_reg_code ON pending_registrations(code);
CREATE INDEX IF NOT EXISTS idx_pending_reg_contact
  ON pending_registrations(channel, channel_user_id);

CREATE TABLE IF NOT EXISTS spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS space_members (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members(user_id);
