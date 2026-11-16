-- CryptoPulse Centralized 9-Stage Monitoring Schema (Strictly Isolated D1)
-- Never binds to production trading DB (`crypto_pulse_db`).
-- Incident storage is strictly read-only forensic telemetry (zero workflow mutation columns).

CREATE TABLE IF NOT EXISTS pipeline_cycles (
  trace_key TEXT PRIMARY KEY,
  journey TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'unknown',
  user_id TEXT,
  bot_id TEXT,
  discovery_cycle_id TEXT,
  approval_generation INTEGER,
  parent_approval_generation INTEGER,
  cycle_id TEXT,
  trace_id TEXT,
  started_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  overall_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  furthest_stage INTEGER NOT NULL DEFAULT 1,
  failed_stage INTEGER,
  failure_code TEXT,
  failure_summary TEXT,
  symbols_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  signals_count INTEGER NOT NULL DEFAULT 0,
  orders_count INTEGER NOT NULL DEFAULT 0,
  fcm_sent_count INTEGER NOT NULL DEFAULT 0,
  android_confirmed_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_cycles_journey_updated ON pipeline_cycles(journey, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cycles_user_updated ON pipeline_cycles(user_id, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_cycles_cycle_id ON pipeline_cycles(cycle_id);
CREATE INDEX IF NOT EXISTS idx_cycles_discovery ON pipeline_cycles(discovery_cycle_id, approval_generation);
CREATE INDEX IF NOT EXISTS idx_cycles_expires ON pipeline_cycles(expires_at_ms);

CREATE TABLE IF NOT EXISTS stage_spans (
  span_id TEXT PRIMARY KEY,
  span_group_id TEXT,
  attempt_number INTEGER,
  journey TEXT NOT NULL,
  stage INTEGER NOT NULL,
  tier TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'unknown',
  user_id TEXT,
  bot_id TEXT,
  discovery_cycle_id TEXT,
  parent_approval_generation INTEGER,
  approval_generation INTEGER,
  cycle_id TEXT,
  trace_id TEXT,
  stage_seq INTEGER NOT NULL DEFAULT 0,
  candle_dataset_id TEXT,
  alert_id TEXT,
  intent_id TEXT,
  client_order_id TEXT,
  order_id TEXT,
  fcm_message_id TEXT,
  android_device_session_hash TEXT,
  emitted_at_ms INTEGER NOT NULL,
  consumer_processed_at_ms INTEGER NOT NULL,
  d1_committed_at_ms INTEGER NOT NULL,
  duration_ms REAL,
  delivery_milestone TEXT NOT NULL,
  symbol TEXT,
  timeframe TEXT,
  strategy_id TEXT,
  component TEXT NOT NULL,
  source_file TEXT,
  error_code TEXT,
  message TEXT NOT NULL,
  input_summary_json TEXT,
  output_summary_json TEXT,
  metadata_json TEXT,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spans_journey_time ON stage_spans(journey, emitted_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_spans_trace_seq ON stage_spans(trace_id, stage, stage_seq);
CREATE INDEX IF NOT EXISTS idx_spans_cycle ON stage_spans(cycle_id, stage, stage_seq);
CREATE INDEX IF NOT EXISTS idx_spans_discovery ON stage_spans(discovery_cycle_id, stage, stage_seq);
CREATE INDEX IF NOT EXISTS idx_spans_symbol_stage ON stage_spans(symbol, stage, emitted_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_spans_stage_status ON stage_spans(stage, status, emitted_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_spans_alert_id ON stage_spans(alert_id);
CREATE INDEX IF NOT EXISTS idx_spans_user_time ON stage_spans(user_id, emitted_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_spans_user_device ON stage_spans(user_id, android_device_session_hash, emitted_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_spans_expires ON stage_spans(expires_at_ms);

CREATE TABLE IF NOT EXISTS stage2_eligibility_decisions (
  decision_id TEXT PRIMARY KEY,
  journey TEXT NOT NULL,
  discovery_cycle_id TEXT,
  approval_generation INTEGER,
  cycle_id TEXT,
  trace_id TEXT,
  user_id TEXT,
  environment TEXT NOT NULL DEFAULT 'unknown',
  symbol TEXT NOT NULL,
  eligible INTEGER NOT NULL,
  decision_outcome TEXT NOT NULL,
  rejection_reason TEXT,
  allocated_budget_usdt REAL,
  account_balance_usdt REAL,
  last_price REAL,
  min_order_qty REAL,
  min_notional_value REAL,
  qty_step REAL,
  computed_qty REAL,
  computed_notional REAL,
  spread_pct REAL,
  volume_24h REAL,
  discovery_score REAL,
  downstream_leaked INTEGER NOT NULL DEFAULT 0,
  decided_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_s2_time ON stage2_eligibility_decisions(decided_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_s2_symbol_time ON stage2_eligibility_decisions(symbol, decided_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_s2_eligible_time ON stage2_eligibility_decisions(eligible, decided_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_s2_generation ON stage2_eligibility_decisions(approval_generation, discovery_cycle_id);
CREATE INDEX IF NOT EXISTS idx_s2_expires ON stage2_eligibility_decisions(expires_at_ms);

CREATE TABLE IF NOT EXISTS ta_indicator_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  journey TEXT NOT NULL,
  discovery_cycle_id TEXT,
  cycle_id TEXT,
  trace_id TEXT,
  user_id TEXT,
  candle_dataset_id TEXT,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  status TEXT NOT NULL,
  skip_reason TEXT,
  candles_count INTEGER,
  min_required_bars INTEGER,
  indicator_engine TEXT NOT NULL,
  rsi REAL,
  ema9 REAL,
  ema21 REAL,
  ema50 REAL,
  ema200 REAL,
  macd_line REAL,
  macd_signal REAL,
  macd_hist REAL,
  adx REAL,
  atr REAL,
  vwap REAL,
  vwap_distance_pct REAL,
  bb_upper REAL,
  bb_lower REAL,
  bb_percent_b REAL,
  volume_ratio REAL,
  regime TEXT,
  confidence_score REAL,
  trend_direction TEXT,
  raw_snapshot_json TEXT,
  computed_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ta_symbol_tf_time ON ta_indicator_snapshots(symbol, timeframe, computed_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_ta_journey_time ON ta_indicator_snapshots(journey, computed_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_ta_trace ON ta_indicator_snapshots(trace_id);
CREATE INDEX IF NOT EXISTS idx_ta_expires ON ta_indicator_snapshots(expires_at_ms);

CREATE TABLE IF NOT EXISTS gate_evaluations (
  gate_eval_id TEXT PRIMARY KEY,
  stage INTEGER NOT NULL,
  journey TEXT NOT NULL,
  cycle_id TEXT,
  trace_id TEXT,
  discovery_cycle_id TEXT,
  user_id TEXT,
  symbol TEXT,
  strategy_id TEXT,
  timeframe TEXT,
  gate_name TEXT NOT NULL,
  gate_category TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  source_file TEXT,
  evaluated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  inputs_json TEXT,
  outputs_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_gate_stage_time ON gate_evaluations(stage, evaluated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_gate_symbol_time ON gate_evaluations(symbol, evaluated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_gate_decision_time ON gate_evaluations(decision, evaluated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_gate_trace ON gate_evaluations(trace_id);
CREATE INDEX IF NOT EXISTS idx_gate_expires ON gate_evaluations(expires_at_ms);

CREATE TABLE IF NOT EXISTS trade_lifecycle_ledger (
  trade_key TEXT PRIMARY KEY,
  user_id TEXT,
  bot_id TEXT,
  cycle_id TEXT,
  trace_id TEXT,
  environment TEXT NOT NULL DEFAULT 'unknown',
  symbol TEXT NOT NULL,
  side TEXT,
  strategy_id TEXT,
  timeframe TEXT,
  alert_id TEXT,
  intent_id TEXT,
  client_order_id TEXT,
  order_id TEXT,
  signal_detected_at_ms INTEGER,
  trade_alert_created_at_ms INTEGER,
  order_intent_reserved_at_ms INTEGER,
  order_submit_dispatched_at_ms INTEGER,
  bybit_http_ack_at_ms INTEGER,
  reconciliation_attempted_at_ms INTEGER,
  exchange_fill_confirmed_at_ms INTEGER,
  exchange_sl_tp_confirmed_at_ms INTEGER,
  position_d1_synced_at_ms INTEGER,
  terminal_failed_at_ms INTEGER,
  current_milestone TEXT NOT NULL,
  execution_status TEXT NOT NULL,
  requested_qty REAL,
  requested_price REAL,
  filled_qty REAL,
  avg_fill_price REAL,
  sl_price REAL,
  tp_price REAL,
  bybit_ret_code INTEGER,
  bybit_ret_msg TEXT,
  error_code TEXT,
  first_seen_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_trade_updated ON trade_lifecycle_ledger(updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_trade_symbol_updated ON trade_lifecycle_ledger(symbol, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_trade_alert ON trade_lifecycle_ledger(alert_id);
CREATE INDEX IF NOT EXISTS idx_trade_order ON trade_lifecycle_ledger(order_id);
CREATE INDEX IF NOT EXISTS idx_trade_client_order ON trade_lifecycle_ledger(client_order_id);
CREATE INDEX IF NOT EXISTS idx_trade_expires ON trade_lifecycle_ledger(expires_at_ms);

CREATE TABLE IF NOT EXISTS notification_parity_ledger (
  correlation_key TEXT PRIMARY KEY,
  alert_id TEXT,
  trace_id TEXT,
  cycle_id TEXT,
  user_id TEXT,
  symbol TEXT,
  strategy_id TEXT,
  timeframe TEXT,
  fcm_message_id TEXT,
  android_device_session_hash TEXT,
  backend_event_type TEXT,
  backend_dispatched_at_ms INTEGER,
  fcm_http_status INTEGER,
  fcm_dispatch_status TEXT,
  backend_payload_json TEXT,
  android_fcm_received_at_ms INTEGER,
  android_poll_received_at_ms INTEGER,
  android_source TEXT,
  android_dedup_outcome TEXT,
  android_eligibility_outcome TEXT,
  android_eligibility_reason TEXT,
  android_post_notify_verified INTEGER,
  android_os_heads_up_state TEXT DEFAULT 'UNKNOWN',
  android_validated_at_ms INTEGER,
  android_validation_outcome TEXT,
  android_validation_reason TEXT,
  android_rendered_at_ms INTEGER,
  android_rendered_fields_json TEXT,
  parity_status TEXT NOT NULL DEFAULT 'PENDING_ANDROID',
  parity_mismatches_json TEXT,
  first_seen_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notif_updated ON notification_parity_ledger(updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_notif_alert ON notification_parity_ledger(alert_id);
CREATE INDEX IF NOT EXISTS idx_notif_fcm ON notification_parity_ledger(fcm_message_id);
CREATE INDEX IF NOT EXISTS idx_notif_parity_status ON notification_parity_ledger(parity_status, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_notif_user_device ON notification_parity_ledger(user_id, android_device_session_hash, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_notif_expires ON notification_parity_ledger(expires_at_ms);

CREATE TABLE IF NOT EXISTS exchange_health_windows (
  window_id TEXT PRIMARY KEY,
  user_id TEXT,
  channel TEXT NOT NULL,
  endpoint TEXT,
  http_status INTEGER,
  ret_code INTEGER,
  latency_ms REAL,
  tokens_remaining INTEGER,
  rate_limit_remaining INTEGER,
  rate_limit_limit INTEGER,
  rate_limit_reset_ms INTEGER,
  instruments_requested INTEGER,
  instruments_received INTEGER,
  cache_tier TEXT,
  stale_count INTEGER,
  invalid_count INTEGER,
  retry_count INTEGER,
  status TEXT NOT NULL,
  error_code TEXT,
  message TEXT,
  recorded_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_exch_channel_time ON exchange_health_windows(channel, recorded_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_exch_user_time ON exchange_health_windows(user_id, recorded_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_exch_expires ON exchange_health_windows(expires_at_ms);

-- Strictly Read-Only Incident Aggregation Table (zero status/resolved/assignee workflow fields)
CREATE TABLE IF NOT EXISTS data_quality_incidents (
  fingerprint TEXT PRIMARY KEY,
  user_id TEXT,
  android_device_session_hash TEXT,
  stage INTEGER NOT NULL,
  component TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  error_code TEXT,
  symbol TEXT,
  strategy_id TEXT,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  latest_trace_id TEXT,
  latest_cycle_id TEXT,
  latest_discovery_cycle_id TEXT,
  latest_message TEXT NOT NULL,
  sample_payload_json TEXT,
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inc_last_seen ON data_quality_incidents(last_seen_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_inc_stage_last ON data_quality_incidents(stage, last_seen_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_inc_user_last ON data_quality_incidents(user_id, last_seen_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_inc_user_device ON data_quality_incidents(user_id, android_device_session_hash, last_seen_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_inc_expires ON data_quality_incidents(expires_at_ms);

CREATE TABLE IF NOT EXISTS telemetry_dlq_records (
  dlq_id TEXT PRIMARY KEY,
  batch_id TEXT,
  producer TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT NOT NULL,
  retry_attempts INTEGER NOT NULL DEFAULT 0,
  received_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  raw_preview_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_dlq_received ON telemetry_dlq_records(received_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_expires ON telemetry_dlq_records(expires_at_ms);

CREATE TABLE IF NOT EXISTS monitoring_self_health (
  metric_key TEXT PRIMARY KEY,
  events_received INTEGER NOT NULL DEFAULT 0,
  events_inserted INTEGER NOT NULL DEFAULT 0,
  events_deduped INTEGER NOT NULL DEFAULT 0,
  dlq_routed INTEGER NOT NULL DEFAULT 0,
  d1_write_errors INTEGER NOT NULL DEFAULT 0,
  last_event_emitted_at_ms INTEGER,
  last_consumer_processed_at_ms INTEGER,
  last_d1_committed_at_ms INTEGER,
  avg_ingest_lag_ms REAL NOT NULL DEFAULT 0,
  max_ingest_lag_ms REAL NOT NULL DEFAULT 0,
  last_error TEXT,
  producer_stats_json TEXT,
  updated_at_ms INTEGER NOT NULL
);
