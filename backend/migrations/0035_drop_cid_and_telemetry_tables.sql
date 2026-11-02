-- Migration 0035: drop_cid_and_telemetry_tables.sql
-- Safely drops obsolete Android continuous diagnostic and bot telemetry tables

DROP TABLE IF EXISTS cid_events;
DROP TABLE IF EXISTS cid_sessions;
DROP TABLE IF EXISTS bot_telemetry_events;
