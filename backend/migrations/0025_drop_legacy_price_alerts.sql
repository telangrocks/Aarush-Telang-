-- Migration 0025: Drop legacy manual price_alerts table and view
DROP VIEW IF EXISTS v_active_price_alerts;
DROP TABLE IF EXISTS price_alerts;
