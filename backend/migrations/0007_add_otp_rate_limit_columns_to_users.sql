-- Migration: add_otp_rate_limit_columns_to_users
-- Adds resend cooldown and OTP attempt tracking for production auth hardening.

ALTER TABLE users ADD COLUMN otp_last_sent_at INTEGER;
ALTER TABLE users ADD COLUMN otp_attempt_count INTEGER NOT NULL DEFAULT 0;
