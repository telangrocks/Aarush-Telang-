-- ============================================================================
-- CryptoPulse Complete Database Schema Reference (Snapshot: Migrations 0000-0029)
-- ============================================================================
-- ARCHITECTURAL NOTICE:
-- THIS FILE IS A REFERENCE DOCUMENTATION SNAPSHOT ONLY.
-- DO NOT EXECUTE THIS FILE AS A MIGRATION SCRIPT AGAINST PRODUCTION OR LOCAL D1.
-- The backend/migrations/ directory (migrations 0000 through 0029) is the SOLE
-- authoritative, state-tracked execution source for Cloudflare D1.
-- ============================================================================

-- ============================================================================
-- 1. USERS TABLE
-- ============================================================================
-- Final state after migrations 0000, 0004, 0005, 0006, 0007, 0008, 0009, 0010,
-- 0012, 0013, 0016, 0020, 0022, 0026, 0027, 0028
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,                                    -- Migration 0009
  status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',-- Migration 0006
  verification_token TEXT,                            -- Migration 0020
  verification_token_expires_at INTEGER,              -- Migration 0020
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,   -- Migration 0008
  locked_until INTEGER,                             -- Migration 0008
  fcm_token TEXT,                                   -- Migration 0004
  exchange_name TEXT DEFAULT NULL,                  -- Migration 0012
  exchange_environment TEXT NOT NULL DEFAULT 'mainnet',-- Migration 0013
  exchange_region TEXT NOT NULL DEFAULT 'india',      -- Migration 0016
  -- Encrypted API Key (AES-256-GCM with PBKDF2 salt)
  exchange_api_key_encrypted TEXT,                  -- Migration 0027
  exchange_api_key_iv TEXT,                         -- Migration 0027
  exchange_api_key_salt TEXT,                       -- Migration 0027
  -- Encrypted API Secret (AES-256-GCM with PBKDF2 salt)
  exchange_api_secret_encrypted TEXT,               -- Migration 0005
  exchange_api_secret_iv TEXT,                      -- Migration 0005
  exchange_api_secret_salt TEXT,                    -- Migration 0027
  -- Encrypted API Passphrase (AES-256-GCM with PBKDF2 salt)
  exchange_api_passphrase_encrypted TEXT,           -- Migration 0026
  exchange_api_passphrase_iv TEXT,                  -- Migration 0026
  exchange_api_passphrase_salt TEXT,                -- Migration 0026
  -- User Security & PIN Lifecycle
  pin_hash TEXT,                                    -- Migration 0022
  pin_attempts INTEGER NOT NULL DEFAULT 0,          -- Migration 0022
  pin_locked_until INTEGER,                         -- Migration 0022
  role TEXT NOT NULL DEFAULT 'user',                -- Migration 0022
  is_deleted INTEGER NOT NULL DEFAULT 0             -- Migration 0022
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_verification_token ON users(verification_token);

-- ============================================================================
-- 2. WATCHLIST TABLE
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_user_token ON watchlist(user_id, token_id);

-- ============================================================================
-- 3. PORTFOLIO_TRANSACTIONS TABLE
-- ============================================================================
-- Migration 0002
CREATE TABLE IF NOT EXISTS portfolio_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  amount REAL NOT NULL,
  buy_price REAL NOT NULL,
  transaction_date TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portfolio_user_id ON portfolio_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_token_id ON portfolio_transactions(token_id);

-- ============================================================================
-- 4. REGISTRATION_ATTEMPTS TABLE (Rate Limiting)
-- ============================================================================
-- Migration 0011
CREATE TABLE IF NOT EXISTS registration_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reg_attempts_window ON registration_attempts(window_start);

-- ============================================================================
-- 5. JWT_BLACKLIST TABLE (Token Revocation)
-- ============================================================================
-- Migration 0017
CREATE TABLE IF NOT EXISTS jwt_blacklist (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jwt_blacklist_expires ON jwt_blacklist(expires_at);

-- ============================================================================
-- 6. REFRESH_TOKENS TABLE
-- ============================================================================
-- Migration 0018
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- ============================================================================
-- 7. LOGIN_ATTEMPTS TABLE (Rate Limiting)
-- ============================================================================
-- Migration 0019
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_window ON login_attempts(window_start);

-- ============================================================================
-- 8. PASSWORD_RESET_TOKENS TABLE
-- ============================================================================
-- Migration 0019
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);

-- ============================================================================
-- 9. AUDIT_LOG TABLE (Immutable Security & Operational Logging)
-- ============================================================================
-- Migration 0021
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

-- ============================================================================
-- 10. USER_SECURITY_SETTINGS TABLE (MFA & Biometrics)
-- ============================================================================
-- Migration 0022
CREATE TABLE IF NOT EXISTS user_security_settings (
  user_id TEXT PRIMARY KEY,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_secret TEXT,
  biometric_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================================
-- 11. USER_DEVICES TABLE (Device Fingerprinting)
-- ============================================================================
-- Migration 0022
CREATE TABLE IF NOT EXISTS user_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_fingerprint TEXT NOT NULL,
  device_name TEXT,
  fcm_token TEXT,
  is_trusted INTEGER NOT NULL DEFAULT 0,
  last_active INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, device_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);

-- ============================================================================
-- 12. PIN_RESET_TOKENS TABLE (PIN Recovery)
-- ============================================================================
-- Migration 0023
CREATE TABLE IF NOT EXISTS pin_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pin_reset_user ON pin_reset_tokens(user_id);

-- ============================================================================
-- 13. TRADE_POSITIONS TABLE (Production Execution & State Tracking)
-- ============================================================================
-- Final state after migrations 0015, 0016, 0024, 0029
CREATE TABLE IF NOT EXISTS trade_positions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL DEFAULT 'LIMIT',
  limit_price REAL,
  target_entry_price REAL,                           -- Migration 0024, 0029
  entry_intent TEXT DEFAULT 'WAIT_FOR_PRICE',        -- Migration 0024
  entry_exchange_order_id TEXT,
  tp_exchange_order_id TEXT,
  sl_exchange_order_id TEXT,
  oco_group_id TEXT,
  protection_mode TEXT NOT NULL DEFAULT 'NATIVE_OCO',
  entry_status TEXT NOT NULL DEFAULT 'pending',
  tp_status TEXT NOT NULL DEFAULT 'untriggered',
  sl_status TEXT NOT NULL DEFAULT 'untriggered',
  filled_quantity REAL DEFAULT 0.0,
  average_fill_price REAL DEFAULT 0.0,
  last_reconciliation_at INTEGER,                    -- Migration 0024
  reconciliation_attempts INTEGER NOT NULL DEFAULT 0,-- Migration 0024
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trade_positions_user ON trade_positions(user_id);
CREATE INDEX IF NOT EXISTS idx_trade_positions_symbol ON trade_positions(symbol);
CREATE INDEX IF NOT EXISTS idx_trade_positions_status ON trade_positions(entry_status);
CREATE INDEX IF NOT EXISTS idx_trade_positions_oco ON trade_positions(oco_group_id);

-- ============================================================================
-- 14. TRADE_EXECUTION_AUDIT TABLE (Latency, Slippage & Audit Logging)
-- ============================================================================
-- Final state after migrations 0016, 0029
CREATE TABLE IF NOT EXISTS trade_execution_audit (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  stage TEXT NOT NULL,
  latency_ms INTEGER,
  fill_price REAL,
  slippage REAL,
  details TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (position_id) REFERENCES trade_positions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trade_audit_position ON trade_execution_audit(position_id);
CREATE INDEX IF NOT EXISTS idx_trade_audit_user ON trade_execution_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_trade_audit_timestamp ON trade_execution_audit(timestamp);

-- ============================================================================
-- 15. AUTOMATIC AUDIT TIMESTAMP TRIGGER
-- ============================================================================
-- Migration 0029
CREATE TRIGGER IF NOT EXISTS trg_trade_execution_audit_timestamp
AFTER INSERT ON trade_execution_audit
FOR EACH ROW
WHEN NEW.timestamp IS NULL OR NEW.timestamp = 0
BEGIN
  UPDATE trade_execution_audit
  SET timestamp = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE id = NEW.id;
END;