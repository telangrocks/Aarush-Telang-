-- Migration: add_fcm_token_to_users
-- Created at: 2026-07-02 17:33:26

ALTER TABLE users ADD COLUMN fcm_token TEXT;