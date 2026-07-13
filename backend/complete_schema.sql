-- CryptoPulse Complete Database Schema
-- Generated from backend/migrations/0000 through 0012
-- This single script creates the entire database schema in the correct final state
-- Run once in Cloudflare D1 SQL Console to create all tables with all columns

-- ============================================================================
-- USERS TABLE
-- ============================================================================
-- Final state after migrations 0000, 0004, 0005, 0006, 0007, 0008, 0009, 0010, 0012
-- Columns DROPPED by migration 0010: is_verified, otp_secret, otp_expires_at, otp_last_sent_at, otp_attempt_count

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,                    -- Migration 0009
  status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',  -- Migration 0006
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,     -- Migration 0008
  locked_until INTEGER,               -- Migration 0008
  fcm_token TEXT,                     -- Migration 0004
  exchange_name TEXT DEFAULT NULL,    -- Migration 0012
  exchange_api_key TEXT,              -- Migration 0005
  exchange_api_secret_iv TEXT,        -- Migration 0005
  exchange_api_secret_encrypted TEXT  -- Migration 0005
);

-- Helpful indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- ============================================================================
-- WATCHLIST TABLE
-- ============================================================================
-- Migration 0001

CREATE TABLE IF NOT EXISTS watchlist (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_watchlist_user_id ON watchlist(user_id);

-- ============================================================================
-- PORTFOLIO_TRANSACTIONS TABLE
-- ============================================================================
-- Migration 0002

CREATE TABLE IF NOT EXISTS portfolio_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  amount REAL NOT NULL,
  buy_price REAL NOT NULL,
  transaction_date TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portfolio_transactions_user_id ON portfolio_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_transactions_token_id ON portfolio_transactions(token_id);

-- ============================================================================
-- PRICE_ALERTS TABLE
-- ============================================================================
-- Migration 0003

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

CREATE INDEX IF NOT EXISTS idx_price_alerts_user_id ON price_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_price_alerts_is_active ON price_alerts(is_active);

-- ============================================================================
-- REGISTRATION_ATTEMPTS TABLE
-- ============================================================================
-- Migration 0011 - Rate limiting for registration endpoint

CREATE TABLE IF NOT EXISTS registration_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- ============================================================================
-- TRIGGERS FOR UPDATED_AT AUTOMATIC MAINTENANCE
-- ============================================================================
-- Keeps users.updated_at in sync on every update

CREATE TRIGGER IF NOT EXISTS trigger_users_updated_at
AFTER UPDATE ON users
BEGIN
  UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================================
-- VIEWS (Optional but useful for common queries)
-- ============================================================================

-- Active users with exchange connected
CREATE VIEW IF NOT EXISTS v_active_users_with_exchange AS
SELECT
  id,
  email,
  status,
  exchange_name,
  created_at,
  updated_at
FROM users
WHERE status = 'ACTIVE'
  AND exchange_name IS NOT NULL;

-- Active price alerts with user info
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

-- User portfolio summary
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
GROUP BY pt.user_id, pt.token_id;

-- ============================================================================
-- SCHEMA VERSION TRACKING (Optional)
-- ============================================================================
-- Useful for debugging which migration version the DB is at

CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Insert records for all applied migrations
INSERT OR IGNORE INTO schema_migrations (migration_name) VALUES
  ('0000_create_users_table'),
  ('0001_create_watchlist_table'),
  ('0002_create_portfolio_transactions_table'),
  ('0003_create_price_alerts_table'),
  ('0004_add_fcm_token_to_users'),
  ('0005_add_exchange_keys_to_users'),
  ('0006_add_auth_verification_columns_to_users'),
  ('0007_add_otp_rate_limit_columns_to_users'),
  ('0008_add_auth_rate_limit_columns_to_users'),
  ('0009_add_updated_at_to_users'),
  ('0010_drop_unused_users_columns'),
  ('0011_add_registration_rate_limit_table'),
  ('0012_add_exchange_name_to_users');

-- ============================================================================
-- VERIFICATION QUERIES (run after execution to confirm schema)
-- ============================================================================

-- Verify all tables exist
-- SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;

-- Verify users table columns
-- PRAGMA table_info(users);

-- Verify foreign keys
-- PRAGMA foreign_key_list(watchlist);
-- PRAGMA foreign_key_list(portfolio_transactions);
-- PRAGMA foreign_key_list(price_alerts);

-- Verify indexes
-- SELECT name FROM sqlite_master WHERE type='index' ORDER BY name;

-- Verify triggers
-- SELECT name FROM sqlite_master WHERE type='trigger';

-- Verify views
-- SELECT name FROM sqlite_master WHERE type='view';

-- Verify migrations table
-- SELECT * FROM schema_migrations;