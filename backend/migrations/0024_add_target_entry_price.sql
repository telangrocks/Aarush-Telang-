-- Migration 0024: Add target_entry_price and average_fill_price to trade_positions, and create trade_execution_audit table
ALTER TABLE trade_positions ADD COLUMN target_entry_price REAL;
ALTER TABLE trade_positions ADD COLUMN average_fill_price REAL;

CREATE TABLE IF NOT EXISTS trade_execution_audit (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  target_entry_price REAL,
  signal_price REAL NOT NULL,
  execution_price REAL NOT NULL,
  average_fill_price REAL NOT NULL,
  stop_loss REAL NOT NULL,
  take_profit REAL NOT NULL,
  slippage_percent REAL NOT NULL,
  fill_timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trade_execution_audit_user_id ON trade_execution_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_trade_execution_audit_alert_id ON trade_execution_audit(alert_id);
