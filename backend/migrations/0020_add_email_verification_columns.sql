-- Migration: add_email_verification_columns
-- Adds email verification token columns for account activation flow.

ALTER TABLE users ADD COLUMN verification_token TEXT;
ALTER TABLE users ADD COLUMN verification_token_expires_at INTEGER;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_users_verification_token ON users(verification_token);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
