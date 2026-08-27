-- Migration 0030: add_exchange_connection_status_to_users.sql

ALTER TABLE users ADD COLUMN exchange_connection_status TEXT NOT NULL DEFAULT 'DISCONNECTED';
ALTER TABLE users ADD COLUMN exchange_invalidated_at TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN exchange_failure_code TEXT DEFAULT NULL;

-- Backfill existing connected users (rows that possess non-null encrypted keys and IVs)
UPDATE users
SET exchange_connection_status = 'CONNECTED'
WHERE exchange_api_key_encrypted IS NOT NULL
  AND exchange_api_secret_encrypted IS NOT NULL
  AND exchange_api_secret_iv IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_exchange_conn_status ON users(exchange_connection_status);
