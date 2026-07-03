-- Migration: add_exchange_keys_to_users
-- Created at: 2026-07-02 17:35:26

ALTER TABLE users ADD COLUMN exchange_api_key TEXT;
ALTER TABLE users ADD COLUMN exchange_api_secret_iv TEXT;
ALTER TABLE users ADD COLUMN exchange_api_secret_encrypted TEXT;