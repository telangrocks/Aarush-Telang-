-- Migration: add_exchange_region_to_users
-- Created at: 2026-07-17
--
-- Stores the exchange REGION (global | india) selected by the user when
-- connecting their exchange.
--
-- Why this matters: Delta Exchange runs separate, geo-fenced deployments. The
-- global endpoint (api.delta.exchange) is CloudFront-fronted and returns a
-- 403 "Request blocked" for Indian traffic. Indian accounts (e.g. Delta
-- Exchange India) MUST use the dedicated India domain (api.india.delta.exchange).
--
-- We default to 'india' so that already-connected Delta users (who are on the
-- India platform) are transparently routed to the correct endpoint without
-- requiring them to reconnect. Users on the global platform can still pass
-- region: "global" explicitly.

ALTER TABLE users ADD COLUMN exchange_region TEXT NOT NULL DEFAULT 'india';
