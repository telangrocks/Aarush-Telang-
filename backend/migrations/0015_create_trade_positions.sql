CREATE TABLE IF NOT EXISTS trade_positions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
  entry_price REAL NOT NULL,
  quantity REAL NOT NULL,
  stop_loss REAL NOT NULL,
  take_profit REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'CLOSED', 'CANCELLED')),
  exchange TEXT NOT NULL,
  environment TEXT NOT NULL,
  strategy TEXT,
  order_id TEXT,
  entry_at TEXT NOT NULL,
  closed_at TEXT,
  close_price REAL,
  realized_pnl REAL,
  close_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_positions_user_id ON trade_positions(user_id);
CREATE INDEX IF NOT EXISTS idx_trade_positions_status ON trade_positions(status);
