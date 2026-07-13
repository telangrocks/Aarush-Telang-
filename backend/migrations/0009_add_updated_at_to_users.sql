-- Migration: add_updated_at_to_users
-- Adds updated_at timestamp for audit trail.

ALTER TABLE users ADD COLUMN updated_at TEXT;
