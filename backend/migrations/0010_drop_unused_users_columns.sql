-- Migration: drop_unused_users_columns
-- Removes columns that are not used by the current authentication flow
-- (the email-verification flag and the disabled OTP flow columns).

ALTER TABLE users DROP COLUMN is_verified;
ALTER TABLE users DROP COLUMN otp_secret;
ALTER TABLE users DROP COLUMN otp_expires_at;
ALTER TABLE users DROP COLUMN otp_last_sent_at;
ALTER TABLE users DROP COLUMN otp_attempt_count;
