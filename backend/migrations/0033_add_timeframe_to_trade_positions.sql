-- Migration 0033: Add originating timeframe to trade_positions and trade_execution_audit
ALTER TABLE trade_positions ADD COLUMN timeframe TEXT;
ALTER TABLE trade_execution_audit ADD COLUMN timeframe TEXT;

CREATE INDEX IF NOT EXISTS idx_trade_positions_timeframe ON trade_positions(timeframe);
