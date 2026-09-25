-- Migration 0031: create_cid_tables.sql
-- Continuous Investigation & Diagnostics (CID) persistence layer.

CREATE TABLE IF NOT EXISTS cid_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  app_version TEXT,
  device_model TEXT,
  environment TEXT NOT NULL DEFAULT 'demo',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'COMPLETED', 'EXPIRED')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cid_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('LIFECYCLE', 'NAVIGATION', 'NETWORK', 'AUTH', 'EXCHANGE', 'BOT', 'CRASH')),
  component TEXT NOT NULL,
  event_name TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'INFO' CHECK(severity IN ('DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL')),
  duration_ms INTEGER,
  correlation_id TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  FOREIGN KEY (session_id) REFERENCES cid_sessions(id) ON DELETE CASCADE,
  UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_cid_events_session_seq ON cid_events(session_id, seq ASC);
CREATE INDEX IF NOT EXISTS idx_cid_events_category ON cid_events(category);
CREATE INDEX IF NOT EXISTS idx_cid_events_severity ON cid_events(severity);
CREATE INDEX IF NOT EXISTS idx_cid_events_timestamp ON cid_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_cid_sessions_user_id ON cid_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_cid_sessions_expires_at ON cid_sessions(expires_at);
