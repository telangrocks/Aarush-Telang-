-- CryptoPulse Database Schema
-- Generated from backend/migrations/ (0000–0007)
-- Migrations are the single source of truth.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  fcm_token TEXT,
  exchange_api_key TEXT,
  exchange_api_secret_iv TEXT,
  exchange_api_secret_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
  otp_secret TEXT,
  otp_expires_at INTEGER,
  otp_last_sent_at INTEGER,
  otp_attempt_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS watchlist (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS portfolio_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  amount REAL NOT NULL,
  buy_price REAL NOT NULL,
  transaction_date TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

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
