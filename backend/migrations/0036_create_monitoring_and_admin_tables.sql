-- Migration 0036: create_monitoring_and_admin_tables.sql
-- Zero-cost centralized monitoring persistence layer & user role authorization.
-- Strictly for local development and preparation. DO NOT run against production without authorization.

-- Note: 'users.role' column is already established by Migration 0022 (0022_add_user_security_features.sql).
-- Duplicate ALTER TABLE statement removed to prevent SQLite migration abort.

-- System Incidents Table: Bounded-window deduplicated, exception-only persistence
CREATE TABLE IF NOT EXISTS system_incidents (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  window_bucket INTEGER NOT NULL DEFAULT 0,
  severity TEXT NOT NULL CHECK(severity IN ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
  source TEXT NOT NULL CHECK(source IN ('BACKEND', 'BOT', 'ANDROID', 'AUTH', 'INFRASTRUCTURE')),
  environment TEXT NOT NULL DEFAULT 'production',
  component TEXT NOT NULL,
  event_type TEXT NOT NULL,
  user_id TEXT,
  bot_id TEXT,
  correlation_id TEXT,
  lifecycle_stage TEXT,
  error_code TEXT,
  message TEXT NOT NULL,
  evidence TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNRESOLVED' CHECK(status IN ('UNRESOLVED', 'INVESTIGATING', 'RESOLVED', 'IGNORED')),
  resolved_at INTEGER,
  resolved_by TEXT,
  resolution_notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_inc_time ON system_incidents(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_inc_fingerprint ON system_incidents(fingerprint, status);
CREATE INDEX IF NOT EXISTS idx_inc_user ON system_incidents(user_id);
CREATE INDEX IF NOT EXISTS idx_inc_corr ON system_incidents(correlation_id);
CREATE INDEX IF NOT EXISTS idx_inc_severity ON system_incidents(severity);
CREATE INDEX IF NOT EXISTS idx_inc_status ON system_incidents(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inc_window_dedup ON system_incidents(fingerprint, window_bucket, status);
