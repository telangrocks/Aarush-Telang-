-- Migration: encrypt_user_api_keys_and_add_salts
-- Created at: 2026-08-10 00:00:00

ALTER TABLE users ADD COLUMN exchange_api_key_iv TEXT;
ALTER TABLE users ADD COLUMN exchange_api_key_encrypted TEXT;
ALTER TABLE users ADD COLUMN exchange_api_key_salt TEXT;
ALTER TABLE users ADD COLUMN exchange_api_secret_salt TEXT;
ALTER TABLE users ADD COLUMN exchange_api_passphrase_salt TEXT;
