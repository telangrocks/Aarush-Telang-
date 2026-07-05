-- Migration: add_auth_verification_columns_to_users
-- Align users table with live authentication handlers.

ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION';
ALTER TABLE users ADD COLUMN otp_secret TEXT;
ALTER TABLE users ADD COLUMN otp_expires_at INTEGER;
