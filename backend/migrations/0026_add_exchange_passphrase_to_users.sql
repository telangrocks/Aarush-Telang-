-- Migration: add_exchange_passphrase_to_users
-- Created at: 2026-07-28 18:27:00

ALTER TABLE users ADD COLUMN exchange_api_passphrase_iv TEXT;
ALTER TABLE users ADD COLUMN exchange_api_passphrase_encrypted TEXT;
