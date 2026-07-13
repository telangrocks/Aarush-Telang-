-- Migration: add_registration_rate_limit_table
-- Tracks registration attempts per IP to throttle account-creation abuse.

CREATE TABLE IF NOT EXISTS registration_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
