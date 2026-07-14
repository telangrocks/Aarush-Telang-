-- Migration: add_exchange_environment_to_users
-- Created at: 2026-07-14 18:15:00
--
-- Stores the exchange environment (mainnet | testnet) selected by the user when
-- connecting their exchange. This ensures credential validation AND all
-- subsequent API calls use the correct endpoint (real vs. sandbox/testnet).
-- Defaults to 'mainnet' to preserve existing behaviour for already-connected users.

ALTER TABLE users ADD COLUMN exchange_environment TEXT NOT NULL DEFAULT 'mainnet';
