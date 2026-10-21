-- Migration 0034: Add leading timestamp index to bot_telemetry_events
CREATE INDEX IF NOT EXISTS idx_bte_timestamp ON bot_telemetry_events(timestamp);
