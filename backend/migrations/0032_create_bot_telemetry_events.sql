-- Migration 0032: create_bot_telemetry_events.sql
-- Dedicated backend autonomous trading diagnostic persistence layer.

CREATE TABLE IF NOT EXISTS bot_telemetry_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('SCANNER', 'CYCLE', 'STRATEGY', 'RISK', 'SAFETY', 'ALERT', 'NOTIFICATION', 'EXECUTION', 'EXCHANGE')),
  component TEXT NOT NULL,
  event_name TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'INFO' CHECK(severity IN ('DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL')),
  correlation_id TEXT,
  cycle_id TEXT,
  symbol TEXT,
  strategy_id TEXT,
  duration_ms INTEGER,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_bte_corr ON bot_telemetry_events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_bte_cycle ON bot_telemetry_events(cycle_id);
CREATE INDEX IF NOT EXISTS idx_bte_user_time ON bot_telemetry_events(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_bte_symbol ON bot_telemetry_events(symbol);
