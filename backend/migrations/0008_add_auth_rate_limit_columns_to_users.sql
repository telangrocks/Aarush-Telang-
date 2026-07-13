-- Migration: add_auth_rate_limit_columns_to_users
-- Adds account lockout columns for production auth hardening.

ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until INTEGER;
