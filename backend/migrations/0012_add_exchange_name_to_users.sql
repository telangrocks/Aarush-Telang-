-- Migration: add_exchange_name_to_users
-- Created at: 2026-07-12 11:17:00

ALTER TABLE users ADD COLUMN exchange_name TEXT DEFAULT NULL;
