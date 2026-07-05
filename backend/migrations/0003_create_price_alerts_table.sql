-- Migration: create_price_alerts_table
-- Created at: 2026-07-02 17:29:26

CREATE TABLE IF NOT EXISTS price_alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  target_price REAL NOT NULL,
  condition TEXT NOT NULL CHECK(condition IN ('ABOVE', 'BELOW')),
  created_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  triggered_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);