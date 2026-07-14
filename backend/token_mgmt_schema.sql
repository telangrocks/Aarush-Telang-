-- ============================================================================
-- CryptoPulse Token Management Feature - Complete Schema Setup
-- Covers: Watchlist, Portfolio Transactions, Price Alerts
-- Run ONCE in Cloudflare D1 SQL Console
-- Idempotent: safe to run even if objects already exist
-- ============================================================================

-- ============================================================================
-- 1. WATCHLIST TABLE
-- ============================================================================
-- Migration 0001: create_watchlist_table
-- Stores user's watched tokens/cryptocurrencies

CREATE TABLE IF NOT EXISTS watchlist (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for efficient user watchlist queries (ORDER BY added_at DESC)
CREATE INDEX IF NOT EXISTS idx_watchlist_user_id ON watchlist(user_id);

-- Composite index for user + token lookups (prevent duplicates)
CREATE INDEX IF NOT EXISTS idx_watchlist_user_token ON watchlist(user_id, token_id);

-- ============================================================================
-- 2. PORTFOLIO_TRANSACTIONS TABLE
-- ============================================================================
-- Migration 0002: create_portfolio_transactions_table
-- Stores user's token purchase/sale transactions (paper trading history)

CREATE TABLE IF NOT EXISTS portfolio_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  amount REAL NOT NULL,
  buy_price REAL NOT NULL,
  transaction_date TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for user's portfolio queries
CREATE INDEX IF NOT EXISTS idx_portfolio_user_id ON portfolio_transactions(user_id);

-- Index for token-specific portfolio queries
CREATE INDEX IF NOT EXISTS idx_portfolio_token_id ON portfolio_transactions(token_id);

-- Composite index for user + token queries
CREATE INDEX IF NOT EXISTS idx_portfolio_user_token ON portfolio_transactions(user_id, token_id);

-- ============================================================================
-- 3. PRICE_ALERTS TABLE
-- ============================================================================
-- Migration 0003: create_price_alerts_table
-- Stores user's price alerts for tokens

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

-- Index for active alerts scan (scheduled handler)
CREATE INDEX IF NOT EXISTS idx_price_alerts_is_active ON price_alerts(is_active);

-- Index for user's alerts
CREATE INDEX IF NOT EXISTS idx_price_alerts_user_id ON price_alerts(user_id);

-- Composite index for user + token queries
CREATE INDEX IF NOT EXISTS idx_price_alerts_user_token ON price_alerts(user_id, token_id);

-- Index for triggered alerts queries
CREATE INDEX IF NOT EXISTS idx_price_alerts_triggered_at ON price_alerts(triggered_at);

-- ============================================================================
-- 4. SUPPORTING INDEXES ON USERS TABLE (for token management queries)
-- ============================================================================

-- Index for user lookup by email (registration/login)
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Index for status filtering (active users)
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- ============================================================================
-- 5. TRIGGER: Auto-maintain updated_at on users table
-- ============================================================================
-- Ensures users.updated_at is automatically updated on any write

CREATE TRIGGER IF NOT EXISTS trigger_users_updated_at
AFTER UPDATE ON users
BEGIN
  UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================================
-- 6. VIEWS FOR COMMON TOKEN MANAGEMENT QUERIES
-- ============================================================================

-- Active price alerts with user email (for scheduled handler)
CREATE VIEW IF NOT EXISTS v_active_price_alerts AS
SELECT
  pa.id,
  pa.user_id,
  u.email AS user_email,
  pa.token_id,
  pa.target_price,
  pa.condition,
  pa.created_at,
  pa.triggered_at
FROM price_alerts pa
JOIN users u ON pa.user_id = u.id
WHERE pa.is_active = 1;

-- User watchlist with token details
CREATE VIEW IF NOT EXISTS v_user_watchlist AS
SELECT
  w.id,
  w.user_id,
  u.email AS user_email,
  w.token_id,
  w.added_at
FROM watchlist w
JOIN users u ON w.user_id = u.id
WHERE u.status = 'ACTIVE';

-- User portfolio summary (aggregated by token)
CREATE VIEW IF NOT EXISTS v_user_portfolio_summary AS
SELECT
  pt.user_id,
  u.email,
  pt.token_id,
  SUM(pt.amount) AS total_amount,
  AVG(pt.buy_price) AS avg_buy_price,
  COUNT(*) AS transaction_count,
  MAX(pt.transaction_date) AS last_transaction
FROM portfolio_transactions pt
JOIN users u ON pt.user_id = u.id
WHERE u.status = 'ACTIVE'
GROUP BY pt.user_id, pt.token_id;

-- ============================================================================
-- 7. SCHEMA MIGRATIONS TRACKING
-- ============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_migrations (migration_name) VALUES
  ('0001_create_watchlist_table'),
  ('0002_create_portfolio_transactions_table'),
  ('0003_create_price_alerts_table'),
  ('token_mgmt_indexes_and_views');

-- ============================================================================
-- VERIFICATION QUERIES (run after execution to confirm)
-- ============================================================================
-- .tables
-- PRAGMA table_info(watchlist);
-- PRAGMA table_info(portfolio_transactions);
-- PRAGMA table_info(price_alerts);
-- PRAGMA index_list(watchlist);
-- PRAGMA index_list(portfolio_transactions);
-- PRAGMA index_list(price_alerts);
-- PRAGMA foreign_key_list(watchlist);
-- PRAGMA foreign_key_list(portfolio_transactions);
-- PRAGMA foreign_key_list(price_alerts);
-- SELECT * FROM schema_migrations;