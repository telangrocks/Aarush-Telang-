-- Priority 2: Idempotent tenant (user & Android device) scoping indexes
-- Note: user_id and android_device_session_hash columns are created in 0001_create_monitoring_schema.sql
-- (verified never applied remotely prior to remediation; no duplicate ALTER TABLE statements).

CREATE INDEX IF NOT EXISTS idx_cycles_user_updated ON pipeline_cycles(user_id, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_spans_user_time ON stage_spans(user_id, emitted_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_spans_user_device ON stage_spans(user_id, android_device_session_hash, emitted_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_s2_user_time ON stage2_eligibility_decisions(user_id, decided_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_ta_user_time ON ta_indicator_snapshots(user_id, computed_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_gate_user_time ON gate_evaluations(user_id, evaluated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_trade_user_updated ON trade_lifecycle_ledger(user_id, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_notif_user_device ON notification_parity_ledger(user_id, android_device_session_hash, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_exch_user_time ON exchange_health_windows(user_id, recorded_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_inc_user_last ON data_quality_incidents(user_id, last_seen_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_inc_user_device ON data_quality_incidents(user_id, android_device_session_hash, last_seen_at_ms DESC);
