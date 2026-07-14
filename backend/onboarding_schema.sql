-- ============================================================================
-- User Onboarding Feature - Complete Schema Setup
-- Run ONCE in Cloudflare D1 SQL Console
-- Idempotent: safe to run even if objects already exist
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. USERS TABLE: Add missing columns (migrations 0008, 0009, 0012)
-- ----------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS exchange_name TEXT DEFAULT NULL;

-- ----------------------------------------------------------------------------
-- 2. USERS TABLE: Drop stale OTP/verification columns (migration 0010)
-- ----------------------------------------------------------------------------
ALTER TABLE users DROP COLUMN IF EXISTS is_verified;
ALTER TABLE users DROP COLUMN IF EXISTS otp_secret;
ALTER TABLE users DROP COLUMN IF EXISTS otp_expires_at;
ALTER TABLE users DROP COLUMN IF EXISTS otp_last_sent_at;
ALTER TABLE users DROP COLUMN IF EXISTS otp_attempt_count;

-- ----------------------------------------------------------------------------
-- 3. REGISTRATION_ATTEMPTS TABLE (migration 0011)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registration_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- ----------------------------------------------------------------------------
-- 4. INDEXES for onboarding query patterns
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
-- email is already UNIQUE (from 0000), ip is PK in registration_attempts

-- ----------------------------------------------------------------------------
-- 5. TRIGGER: Auto-maintain users.updated_at on every write
-- ----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trigger_users_updated_at
AFTER UPDATE ON users
BEGIN
  UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- 6. SCHEMA MIGRATIONS TRACKING TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
-- VERIFICATION QUERIES (run after execution to confirm)
-- ============================================================================
-- .tables
-- PRAGMA table_info(users);
-- PRAGMA table_info(registration_attempts);
-- PRAGMA foreign_key_list(users);
-- SELECT * FROM schema_migrations;