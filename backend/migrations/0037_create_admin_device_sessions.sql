-- Migration 0037: create_admin_device_sessions.sql
-- Zero-cost persistent device session management & single-use activation tokens.

CREATE TABLE IF NOT EXISTS admin_device_sessions (
  session_id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  session_token_hash TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_dev_sess_hash ON admin_device_sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_dev_sess_status ON admin_device_sessions(revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS admin_activation_tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_act_tok_hash ON admin_activation_tokens(token_hash);
