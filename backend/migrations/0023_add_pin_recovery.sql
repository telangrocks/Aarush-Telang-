-- Migration: add_pin_recovery
-- Adds PIN-based account recovery support.

ALTER TABLE users ADD COLUMN pin_hash TEXT;
ALTER TABLE users ADD COLUMN pin_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN pin_locked_until TEXT;

CREATE TABLE IF NOT EXISTS pin_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_pin_reset_tokens_user_id ON pin_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_pin_reset_tokens_token ON pin_reset_tokens(token);
