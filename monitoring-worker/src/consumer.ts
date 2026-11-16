import {
  ANDROID_DEDUP_DECISIONS,
  ANDROID_HEADSUP_STATES,
  ANDROID_VALIDATION_OUTCOMES,
  MONITORING_RETENTION_MS,
  PARITY_STATUSES,
  PipelineTelemetryEvent,
  STAGE9_EVENT_TYPES,
  STAGE9_LEGACY_EVENT_ALIASES,
  TelemetryQueueEnvelope,
  computeIncidentFingerprint,
  generateSpanId,
  isStage9ConfirmedEvent,
  isStage9PopupRenderedEvent,
  sanitizeTelemetryEvent,
  scrubSensitiveString,
} from '../../shared/monitoring';
import { IngestOutcome, MonitoringEnv, TelemetryQueueBatch } from './types';

const EXECUTION_RANK: Record<string, number> = {
  SIGNAL_ONLY: 1,
  INTENT_RESERVED: 2,
  SUBMITTED_PENDING_ACK: 3,
  BYBIT_ACKED: 4,
  FILL_CONFIRMED: 5,
  PROTECTED: 6,
  FAILED: 99,
};

function computeExpiryMs(event: PipelineTelemetryEvent): number {
  const base = event.emittedAtMs || Date.now();
  if (event.stage === 7 || event.tier === 'TIER_1') {
    return base + MONITORING_RETENTION_MS.TIER_1_EXECUTION;
  }
  if (event.stage === 6 || event.stage === 8 || event.stage === 9) {
    return base + MONITORING_RETENTION_MS.GATES_AND_NOTIFICATIONS;
  }
  return base + MONITORING_RETENTION_MS.DIAGNOSTIC_SPANS;
}

export function resolveTraceKey(event: PipelineTelemetryEvent): string {
  if (event.journey === 'JOURNEY_A_DISCOVERY') {
    return event.discoveryCycleId || event.cycleId || event.traceId || event.spanId;
  }
  return event.traceId || event.cycleId || event.discoveryCycleId || event.spanId;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asBoolean(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function jsonOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

async function fetchExistingSpanIds(db: D1Database, spanIds: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  const chunkSize = 40;
  for (let i = 0; i < spanIds.length; i += chunkSize) {
    const chunk = spanIds.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const res = await db
      .prepare(`SELECT span_id FROM stage_spans WHERE span_id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ span_id: string }>();
    for (const row of res.results || []) {
      existing.add(row.span_id);
    }
  }
  return existing;
}

function buildCycleUpsertStatement(db: D1Database, ev: PipelineTelemetryEvent, expiryMs: number): D1PreparedStatement {
  const traceKey = resolveTraceKey(ev);
  const out = ev.outputSummary || {};
  const symbolsCount = asNumber(out.instrumentsReceived ?? out.symbolsCount ?? out.tickersCount) ?? 0;
  const acceptedCount = asNumber(out.acceptedCount) ?? 0;
  const signalsCount =
    ev.stage === 5 && (out.signalGenerated === true || ev.eventType === 'SIGNAL_DETECTED')
      ? 1
      : asNumber(out.signalsCount) ?? 0;
  const ordersCount =
    ev.stage === 7 && ev.eventType === 'EXCHANGE_FILL_CONFIRMED'
      ? 1
      : asNumber(out.ordersCount) ?? 0;
  const fcmSentCount =
    ev.stage === 8 && ev.status === 'PASS' && ev.eventType.includes('FCM')
      ? 1
      : 0;
  const androidConfirmedCount = isStage9ConfirmedEvent(ev) ? 1 : 0;

  const isFailure = ev.status === 'FAIL';
  const failedStage = isFailure ? ev.stage : null;
  const failureCode = isFailure ? ev.errorCode || ev.eventType : null;
  const failureSummary = isFailure ? ev.message : null;

  return db
    .prepare(
      `INSERT INTO pipeline_cycles (
        trace_key, journey, environment, user_id, bot_id, discovery_cycle_id,
        approval_generation, parent_approval_generation, cycle_id, trace_id,
        started_at_ms, updated_at_ms, expires_at_ms, overall_status, furthest_stage,
        failed_stage, failure_code, failure_summary,
        symbols_count, accepted_count, signals_count, orders_count, fcm_sent_count, android_confirmed_count,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trace_key) DO UPDATE SET
        environment = CASE WHEN excluded.environment != 'unknown' THEN excluded.environment ELSE pipeline_cycles.environment END,
        user_id = COALESCE(pipeline_cycles.user_id, excluded.user_id),
        bot_id = COALESCE(pipeline_cycles.bot_id, excluded.bot_id),
        discovery_cycle_id = COALESCE(pipeline_cycles.discovery_cycle_id, excluded.discovery_cycle_id),
        approval_generation = COALESCE(excluded.approval_generation, pipeline_cycles.approval_generation),
        parent_approval_generation = COALESCE(pipeline_cycles.parent_approval_generation, excluded.parent_approval_generation),
        cycle_id = COALESCE(pipeline_cycles.cycle_id, excluded.cycle_id),
        trace_id = COALESCE(pipeline_cycles.trace_id, excluded.trace_id),
        started_at_ms = MIN(pipeline_cycles.started_at_ms, excluded.started_at_ms),
        updated_at_ms = MAX(pipeline_cycles.updated_at_ms, excluded.updated_at_ms),
        expires_at_ms = MAX(pipeline_cycles.expires_at_ms, excluded.expires_at_ms),
        furthest_stage = MAX(pipeline_cycles.furthest_stage, excluded.furthest_stage),
        overall_status = CASE
          WHEN pipeline_cycles.overall_status = 'FAIL' OR excluded.overall_status = 'FAIL' THEN 'FAIL'
          WHEN pipeline_cycles.overall_status = 'WARN' OR excluded.overall_status = 'WARN' THEN 'WARN'
          WHEN pipeline_cycles.overall_status = 'PASS' OR excluded.overall_status = 'PASS' THEN 'PASS'
          WHEN pipeline_cycles.overall_status = 'SKIPPED' OR excluded.overall_status = 'SKIPPED' THEN 'SKIPPED'
          ELSE excluded.overall_status
        END,
        failed_stage = COALESCE(pipeline_cycles.failed_stage, excluded.failed_stage),
        failure_code = COALESCE(pipeline_cycles.failure_code, excluded.failure_code),
        failure_summary = COALESCE(pipeline_cycles.failure_summary, excluded.failure_summary),
        symbols_count = MAX(pipeline_cycles.symbols_count, excluded.symbols_count),
        accepted_count = MAX(pipeline_cycles.accepted_count, excluded.accepted_count),
        signals_count = pipeline_cycles.signals_count + excluded.signals_count,
        orders_count = pipeline_cycles.orders_count + excluded.orders_count,
        fcm_sent_count = pipeline_cycles.fcm_sent_count + excluded.fcm_sent_count,
        android_confirmed_count = pipeline_cycles.android_confirmed_count + excluded.android_confirmed_count,
        metadata_json = COALESCE(excluded.metadata_json, pipeline_cycles.metadata_json)`
    )
    .bind(
      traceKey,
      ev.journey,
      ev.environment,
      ev.userId ?? null,
      ev.botId ?? null,
      ev.discoveryCycleId ?? null,
      ev.approvalGeneration ?? null,
      ev.parentApprovalGeneration ?? null,
      ev.cycleId ?? null,
      ev.traceId ?? null,
      ev.emittedAtMs,
      ev.emittedAtMs,
      expiryMs,
      ev.status,
      ev.stage,
      failedStage,
      failureCode,
      failureSummary,
      symbolsCount,
      acceptedCount,
      signalsCount,
      ordersCount,
      fcmSentCount,
      androidConfirmedCount,
      jsonOrNull(ev.metadata)
    );
}

function buildStage1WindowStatement(db: D1Database, ev: PipelineTelemetryEvent, expiryMs: number): D1PreparedStatement | null {
  if (ev.stage !== 1) return null;
  const inp = ev.inputSummary || {};
  const out = ev.outputSummary || {};
  const channel =
    asString(out.channel ?? inp.channel) ||
    (ev.eventType.includes('AUTH') || ev.eventType.includes('ACCOUNT')
      ? 'AUTHENTICATED_ACCOUNT'
      : ev.eventType.includes('COORDINATOR')
        ? 'COORDINATOR_STATS'
        : ev.eventType.includes('RATE_LIMIT')
          ? 'RATE_LIMITER'
          : 'PUBLIC_MARKET_DATA');

  return db
    .prepare(
      `INSERT OR IGNORE INTO exchange_health_windows (
        window_id, user_id, channel, endpoint, http_status, ret_code, latency_ms,
        tokens_remaining, rate_limit_remaining, rate_limit_limit, rate_limit_reset_ms,
        instruments_requested, instruments_received, cache_tier,
        stale_count, invalid_count, retry_count, status, error_code, message,
        recorded_at_ms, expires_at_ms, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      ev.spanId,
      ev.userId ?? null,
      channel,
      asString(inp.endpoint ?? out.endpoint),
      asNumber(out.httpStatus),
      asNumber(out.retCode),
      ev.durationMs ?? asNumber(out.latencyMs),
      asNumber(out.tokensRemaining),
      asNumber(out.rateLimitRemaining),
      asNumber(out.rateLimitLimit),
      asNumber(out.rateLimitResetMs),
      asNumber(inp.instrumentsRequested ?? out.instrumentsRequested),
      asNumber(out.instrumentsReceived),
      asString(out.cacheTier),
      asNumber(out.staleCount),
      asNumber(out.invalidCount),
      asNumber(out.retryCount ?? ev.attemptNumber),
      ev.status,
      ev.errorCode ?? null,
      ev.message,
      ev.emittedAtMs,
      expiryMs,
      jsonOrNull({ inputSummary: ev.inputSummary, outputSummary: ev.outputSummary, metadata: ev.metadata })
    );
}

function buildStage2EligibilityStatement(db: D1Database, ev: PipelineTelemetryEvent, expiryMs: number): D1PreparedStatement | null {
  if (ev.stage !== 2 || !ev.symbol) return null;
  const inp = ev.inputSummary || {};
  const out = ev.outputSummary || {};
  const isEligible =
    out.eligible === true ||
    ev.eventType === 'TICKER_ELIGIBLE' ||
    (ev.status === 'PASS' && !ev.eventType.includes('REJECT'));

  return db
    .prepare(
      `INSERT OR IGNORE INTO stage2_eligibility_decisions (
        decision_id, journey, discovery_cycle_id, approval_generation, cycle_id, trace_id, user_id,
        environment, symbol, eligible, decision_outcome, rejection_reason,
        allocated_budget_usdt, account_balance_usdt, last_price, min_order_qty, min_notional_value,
        qty_step, computed_qty, computed_notional, spread_pct, volume_24h, discovery_score,
        downstream_leaked, decided_at_ms, expires_at_ms, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .bind(
      ev.spanId,
      ev.journey,
      ev.discoveryCycleId ?? null,
      ev.approvalGeneration ?? null,
      ev.cycleId ?? null,
      ev.traceId ?? null,
      ev.userId ?? null,
      ev.environment,
      ev.symbol,
      isEligible ? 1 : 0,
      isEligible ? 'ACCEPTED' : 'REJECTED',
      isEligible ? null : asString(out.rejectionReason) || ev.errorCode || ev.message,
      asNumber(inp.allocatedBudgetUsdt ?? out.allocatedBudgetUsdt),
      asNumber(inp.accountBalanceUsdt ?? out.accountBalanceUsdt),
      asNumber(inp.lastPrice ?? out.lastPrice),
      asNumber(inp.minOrderQty ?? out.minOrderQty),
      asNumber(inp.minNotionalValue ?? out.minNotionalValue),
      asNumber(inp.qtyStep ?? out.qtyStep),
      asNumber(out.computedQty),
      asNumber(out.computedNotional),
      asNumber(inp.spreadPct ?? out.spreadPct),
      asNumber(inp.volume24h ?? out.volume24h),
      asNumber(out.discoveryScore),
      ev.emittedAtMs,
      expiryMs,
      jsonOrNull({ inputSummary: ev.inputSummary, outputSummary: ev.outputSummary })
    );
}

function buildDownstreamLeakCheckStatements(db: D1Database, ev: PipelineTelemetryEvent): D1PreparedStatement[] {
  if (ev.stage < 3 || ev.stage > 8 || !ev.symbol) return [];
  const stmts: D1PreparedStatement[] = [];
  const userId = ev.userId ?? null;
  if (ev.journey === 'JOURNEY_B_AUTONOMOUS' && ev.parentApprovalGeneration !== undefined) {
    stmts.push(
      db
        .prepare(
          `UPDATE stage2_eligibility_decisions
           SET downstream_leaked = 1
           WHERE eligible = 0
             AND symbol = ?
             AND approval_generation = ?
             AND decided_at_ms <= ?
             AND ((? IS NOT NULL AND (user_id = ? OR user_id IS NULL)) OR (? IS NULL AND user_id IS NULL))`
        )
        .bind(ev.symbol, ev.parentApprovalGeneration, ev.emittedAtMs, userId, userId, userId)
    );
  } else if (ev.discoveryCycleId) {
    stmts.push(
      db
        .prepare(
          `UPDATE stage2_eligibility_decisions
           SET downstream_leaked = 1
           WHERE eligible = 0
             AND symbol = ?
             AND discovery_cycle_id = ?
             AND decided_at_ms <= ?
             AND ((? IS NOT NULL AND (user_id = ? OR user_id IS NULL)) OR (? IS NULL AND user_id IS NULL))`
        )
        .bind(ev.symbol, ev.discoveryCycleId, ev.emittedAtMs, userId, userId, userId)
    );
  }
  return stmts;
}

function buildStage4TaStatement(db: D1Database, ev: PipelineTelemetryEvent, expiryMs: number): D1PreparedStatement | null {
  if (ev.stage !== 4 || !ev.symbol) return null;
  const out = ev.outputSummary || {};
  const inp = ev.inputSummary || {};
  const timeframe = ev.timeframe || asString(out.timeframe) || asString(inp.timeframe);
  if (!timeframe) return null;

  // Anti-fabrication: skipped snapshots strictly store NULL numeric indicator fields.
  const isSkipped = ev.status === 'SKIPPED';
  const numOrNull = (val: unknown) => (isSkipped ? null : asNumber(val));
  const engine =
    asString(out.indicatorEngine ?? inp.indicatorEngine) ||
    (ev.journey === 'JOURNEY_A_DISCOVERY' ? 'SCANNER_SIMPLE' : 'CANONICAL');

  return db
    .prepare(
      `INSERT OR IGNORE INTO ta_indicator_snapshots (
        snapshot_id, journey, discovery_cycle_id, cycle_id, trace_id, user_id,
        candle_dataset_id, symbol, timeframe, status, skip_reason,
        candles_count, min_required_bars, indicator_engine,
        rsi, ema9, ema21, ema50, ema200,
        macd_line, macd_signal, macd_hist, adx, atr,
        vwap, vwap_distance_pct, bb_upper, bb_lower, bb_percent_b, volume_ratio,
        regime, confidence_score, trend_direction, raw_snapshot_json,
        computed_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      ev.spanId,
      ev.journey,
      ev.discoveryCycleId ?? null,
      ev.cycleId ?? null,
      ev.traceId ?? null,
      ev.userId ?? null,
      ev.candleDatasetId ?? asString(inp.candleDatasetId),
      ev.symbol,
      timeframe,
      ev.status,
      isSkipped ? asString(out.skipReason) || ev.errorCode || 'INSUFFICIENT_BARS' : null,
      asNumber(inp.candlesCount ?? out.candlesCount),
      asNumber(inp.minRequiredBars ?? out.minRequiredBars),
      engine,
      numOrNull(out.rsi),
      numOrNull(out.ema9),
      numOrNull(out.ema21),
      numOrNull(out.ema50),
      numOrNull(out.ema200),
      numOrNull(out.macdLine),
      numOrNull(out.macdSignal),
      numOrNull(out.macdHist),
      numOrNull(out.adx),
      numOrNull(out.atr),
      numOrNull(out.vwap),
      numOrNull(out.vwapDistancePct),
      numOrNull(out.bbUpper),
      numOrNull(out.bbLower),
      numOrNull(out.bbPercentB),
      numOrNull(out.volumeRatio),
      isSkipped ? null : asString(out.regime),
      numOrNull(out.confidenceScore),
      isSkipped ? null : asString(out.trendDirection),
      jsonOrNull({ inputSummary: ev.inputSummary, outputSummary: ev.outputSummary }),
      ev.emittedAtMs,
      expiryMs
    );
}

function buildGateEvaluationStatement(db: D1Database, ev: PipelineTelemetryEvent, expiryMs: number): D1PreparedStatement | null {
  if (ev.stage !== 5 && ev.stage !== 6) return null;
  const inp = ev.inputSummary || {};
  const out = ev.outputSummary || {};

  const gateName = asString(out.gateName ?? inp.gateName) || ev.component || ev.eventType;
  const gateCategory =
    asString(out.gateCategory ?? inp.gateCategory) ||
    (ev.stage === 5
      ? 'STRATEGY'
      : ev.eventType.includes('SHADOW')
        ? 'SHADOW_DIFF'
        : ev.eventType.includes('LIFECYCLE')
          ? 'SIGNAL_LIFECYCLE'
          : ev.eventType.includes('ELIGIBILITY')
            ? 'ELIGIBILITY_GATE'
            : ev.eventType.includes('VALIDATOR')
              ? 'VALIDATOR'
              : ev.eventType.includes('DISPATCH')
                ? 'DISPATCH_GATE'
                : ev.eventType.includes('FENCE')
                  ? 'FENCE'
                  : 'INLINE_ALARM_GATE');

  const decision =
    asString(out.decision) ||
    (ev.status === 'SKIPPED'
      ? 'SKIPPED'
      : ev.status === 'FAIL'
        ? 'BLOCK'
        : ev.status === 'WARN'
          ? 'WARN'
          : 'ALLOW');

  return db
    .prepare(
      `INSERT OR IGNORE INTO gate_evaluations (
        gate_eval_id, stage, journey, cycle_id, trace_id, discovery_cycle_id,
        user_id, symbol, strategy_id, timeframe, gate_name, gate_category,
        decision, reason, source_file, evaluated_at_ms, expires_at_ms, inputs_json, outputs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      ev.spanId,
      ev.stage,
      ev.journey,
      ev.cycleId ?? null,
      ev.traceId ?? null,
      ev.discoveryCycleId ?? null,
      ev.userId ?? null,
      ev.symbol ?? null,
      ev.strategyId ?? asString(out.strategyId),
      ev.timeframe ?? null,
      gateName,
      gateCategory,
      decision,
      asString(out.reason) || ev.message,
      ev.sourceFile ?? null,
      ev.emittedAtMs,
      expiryMs,
      jsonOrNull(ev.inputSummary),
      jsonOrNull(ev.outputSummary)
    );
}

interface TradeState {
  tradeKey: string;
  userId: string | null;
  botId: string | null;
  cycleId: string | null;
  traceId: string | null;
  environment: string;
  symbol: string;
  side: string | null;
  strategyId: string | null;
  timeframe: string | null;
  alertId: string | null;
  intentId: string | null;
  clientOrderId: string | null;
  orderId: string | null;
  signalDetectedAtMs: number | null;
  tradeAlertCreatedAtMs: number | null;
  orderIntentReservedAtMs: number | null;
  orderSubmitDispatchedAtMs: number | null;
  bybitHttpAckAtMs: number | null;
  reconciliationAttemptedAtMs: number | null;
  exchangeFillConfirmedAtMs: number | null;
  exchangeSlTpConfirmedAtMs: number | null;
  positionD1SyncedAtMs: number | null;
  terminalFailedAtMs: number | null;
  currentMilestone: string;
  executionStatus: string;
  requestedQty: number | null;
  requestedPrice: number | null;
  filledQty: number | null;
  avgFillPrice: number | null;
  slPrice: number | null;
  tpPrice: number | null;
  bybitRetCode: number | null;
  bybitRetMsg: string | null;
  errorCode: string | null;
  firstSeenAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  detailsJson: string | null;
}

function classifyTradeMilestone(ev: PipelineTelemetryEvent): { status: string; milestone: string; field?: keyof TradeState } {
  if (ev.status === 'FAIL' || ev.eventType.includes('FAILED')) {
    return { status: 'FAILED', milestone: ev.eventType, field: 'terminalFailedAtMs' };
  }
  switch (ev.eventType) {
    case 'SIGNAL_DETECTED':
      return { status: 'SIGNAL_ONLY', milestone: 'SIGNAL_DETECTED', field: 'signalDetectedAtMs' };
    case 'TRADE_ALERT_CREATED':
      return { status: 'SIGNAL_ONLY', milestone: 'TRADE_ALERT_CREATED', field: 'tradeAlertCreatedAtMs' };
    case 'ORDER_INTENT_RESERVED':
      return { status: 'INTENT_RESERVED', milestone: 'ORDER_INTENT_RESERVED', field: 'orderIntentReservedAtMs' };
    case 'ORDER_SUBMIT_DISPATCHED':
      return { status: 'SUBMITTED_PENDING_ACK', milestone: 'ORDER_SUBMIT_DISPATCHED', field: 'orderSubmitDispatchedAtMs' };
    case 'BYBIT_HTTP_ACK':
      return { status: 'BYBIT_ACKED', milestone: 'BYBIT_HTTP_ACK', field: 'bybitHttpAckAtMs' };
    case 'RECONCILIATION_ATTEMPT':
      return { status: 'BYBIT_ACKED', milestone: 'RECONCILIATION_ATTEMPT', field: 'reconciliationAttemptedAtMs' };
    case 'EXCHANGE_FILL_CONFIRMED':
      return { status: 'FILL_CONFIRMED', milestone: 'EXCHANGE_FILL_CONFIRMED', field: 'exchangeFillConfirmedAtMs' };
    case 'EXCHANGE_SL_TP_CONFIRMED':
      return { status: 'PROTECTED', milestone: 'EXCHANGE_SL_TP_CONFIRMED', field: 'exchangeSlTpConfirmedAtMs' };
    case 'POSITION_D1_SYNCED':
      return { status: 'PROTECTED', milestone: 'POSITION_D1_SYNCED', field: 'positionD1SyncedAtMs' };
    default:
      return { status: 'SIGNAL_ONLY', milestone: ev.eventType };
  }
}

function isTradeLifecycleEvent(ev: PipelineTelemetryEvent): boolean {
  if (ev.stage === 7) return true;
  if (
    ev.eventType === 'SIGNAL_DETECTED' ||
    ev.eventType === 'TRADE_ALERT_CREATED' ||
    Boolean(ev.clientOrderId || ev.intentId || ev.orderId)
  ) {
    return Boolean(ev.symbol);
  }
  return false;
}

function computeTradeKey(ev: PipelineTelemetryEvent): string {
  const raw = ev.clientOrderId || ev.intentId || ev.orderId || ev.alertId || ev.spanId;
  return ev.userId ? `${ev.userId}:${raw}` : raw;
}

async function resolveExistingTradeState(db: D1Database, ev: PipelineTelemetryEvent): Promise<TradeState | null> {
  const candidates = [ev.clientOrderId, ev.intentId, ev.orderId, ev.alertId].filter((x): x is string => Boolean(x));
  if (candidates.length === 0) return null;

  const rawKey = ev.clientOrderId || ev.intentId || ev.orderId || ev.alertId || ev.spanId;
  const scopedKey = computeTradeKey(ev);
  const userId = ev.userId ?? null;
  const row = await db
    .prepare(
      `SELECT * FROM trade_lifecycle_ledger
       WHERE (client_order_id = ? OR intent_id = ? OR order_id = ? OR alert_id = ? OR trade_key IN (?, ?))
         AND (? IS NULL OR user_id IS NULL OR user_id = ?)
       ORDER BY CASE WHEN user_id = ? THEN 0 WHEN user_id IS NULL THEN 1 ELSE 2 END ASC
       LIMIT 1`
    )
    .bind(
      ev.clientOrderId ?? '__NONE__',
      ev.intentId ?? '__NONE__',
      ev.orderId ?? '__NONE__',
      ev.alertId ?? '__NONE__',
      scopedKey,
      rawKey,
      userId,
      userId,
      userId
    )
    .first<Record<string, unknown>>();

  if (!row) return null;
  if (row.user_id && ev.userId && String(row.user_id) !== ev.userId) return null;
  return {
    tradeKey: String(row.trade_key),
    userId: (row.user_id as string | null) ?? null,
    botId: (row.bot_id as string | null) ?? null,
    cycleId: (row.cycle_id as string | null) ?? null,
    traceId: (row.trace_id as string | null) ?? null,
    environment: String(row.environment || 'unknown'),
    symbol: String(row.symbol),
    side: (row.side as string | null) ?? null,
    strategyId: (row.strategy_id as string | null) ?? null,
    timeframe: (row.timeframe as string | null) ?? null,
    alertId: (row.alert_id as string | null) ?? null,
    intentId: (row.intent_id as string | null) ?? null,
    clientOrderId: (row.client_order_id as string | null) ?? null,
    orderId: (row.order_id as string | null) ?? null,
    signalDetectedAtMs: asNumber(row.signal_detected_at_ms),
    tradeAlertCreatedAtMs: asNumber(row.trade_alert_created_at_ms),
    orderIntentReservedAtMs: asNumber(row.order_intent_reserved_at_ms),
    orderSubmitDispatchedAtMs: asNumber(row.order_submit_dispatched_at_ms),
    bybitHttpAckAtMs: asNumber(row.bybit_http_ack_at_ms),
    reconciliationAttemptedAtMs: asNumber(row.reconciliation_attempted_at_ms),
    exchangeFillConfirmedAtMs: asNumber(row.exchange_fill_confirmed_at_ms),
    exchangeSlTpConfirmedAtMs: asNumber(row.exchange_sl_tp_confirmed_at_ms),
    positionD1SyncedAtMs: asNumber(row.position_d1_synced_at_ms),
    terminalFailedAtMs: asNumber(row.terminal_failed_at_ms),
    currentMilestone: String(row.current_milestone),
    executionStatus: String(row.execution_status),
    requestedQty: asNumber(row.requested_qty),
    requestedPrice: asNumber(row.requested_price),
    filledQty: asNumber(row.filled_qty),
    avgFillPrice: asNumber(row.avg_fill_price),
    slPrice: asNumber(row.sl_price),
    tpPrice: asNumber(row.tp_price),
    bybitRetCode: asNumber(row.bybit_ret_code),
    bybitRetMsg: (row.bybit_ret_msg as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    firstSeenAtMs: Number(row.first_seen_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    detailsJson: (row.details_json as string | null) ?? null,
  };
}

function mergeTradeEventIntoState(
  prev: TradeState | null,
  ev: PipelineTelemetryEvent,
  expiryMs: number
): TradeState {
  const tradeKey = prev?.tradeKey || computeTradeKey(ev);
  const inp = ev.inputSummary || {};
  const out = ev.outputSummary || {};
  const classified = classifyTradeMilestone(ev);

  const prevRank = prev ? EXECUTION_RANK[prev.executionStatus] ?? 0 : 0;
  const nextRank = EXECUTION_RANK[classified.status] ?? 0;
  const executionStatus =
    nextRank >= prevRank ? classified.status : prev!.executionStatus;
  const currentMilestone =
    nextRank >= prevRank ? classified.milestone : prev!.currentMilestone;

  const state: TradeState = prev
    ? { ...prev }
    : {
        tradeKey,
        userId: ev.userId ?? null,
        botId: ev.botId ?? null,
        cycleId: ev.cycleId ?? null,
        traceId: ev.traceId ?? null,
        environment: ev.environment,
        symbol: ev.symbol || 'UNKNOWN',
        side: asString(inp.side ?? out.side),
        strategyId: ev.strategyId ?? null,
        timeframe: ev.timeframe ?? null,
        alertId: ev.alertId ?? null,
        intentId: ev.intentId ?? null,
        clientOrderId: ev.clientOrderId ?? null,
        orderId: ev.orderId ?? null,
        signalDetectedAtMs: null,
        tradeAlertCreatedAtMs: null,
        orderIntentReservedAtMs: null,
        orderSubmitDispatchedAtMs: null,
        bybitHttpAckAtMs: null,
        reconciliationAttemptedAtMs: null,
        exchangeFillConfirmedAtMs: null,
        exchangeSlTpConfirmedAtMs: null,
        positionD1SyncedAtMs: null,
        terminalFailedAtMs: null,
        currentMilestone,
        executionStatus,
        requestedQty: null,
        requestedPrice: null,
        filledQty: null,
        avgFillPrice: null,
        slPrice: null,
        tpPrice: null,
        bybitRetCode: null,
        bybitRetMsg: null,
        errorCode: null,
        firstSeenAtMs: ev.emittedAtMs,
        updatedAtMs: ev.emittedAtMs,
        expiresAtMs: expiryMs,
        detailsJson: null,
      };

  state.userId = state.userId || ev.userId || null;
  state.botId = state.botId || ev.botId || null;
  state.cycleId = state.cycleId || ev.cycleId || null;
  state.traceId = state.traceId || ev.traceId || null;
  if (ev.environment !== 'unknown') state.environment = ev.environment;
  if (ev.symbol) state.symbol = ev.symbol;
  state.side = state.side || asString(inp.side ?? out.side);
  state.strategyId = state.strategyId || ev.strategyId || null;
  state.timeframe = state.timeframe || ev.timeframe || null;
  state.alertId = state.alertId || ev.alertId || null;
  state.intentId = state.intentId || ev.intentId || null;
  state.clientOrderId = state.clientOrderId || ev.clientOrderId || null;
  state.orderId = state.orderId || ev.orderId || asString(out.orderId);
  state.currentMilestone = currentMilestone;
  state.executionStatus = executionStatus;
  state.requestedQty = asNumber(inp.requestedQty ?? inp.qty) ?? state.requestedQty;
  state.requestedPrice = asNumber(inp.requestedPrice ?? inp.price) ?? state.requestedPrice;
  state.filledQty = asNumber(out.filledQty ?? out.cumExecQty) ?? state.filledQty;
  state.avgFillPrice = asNumber(out.avgFillPrice ?? out.avgPrice) ?? state.avgFillPrice;
  state.slPrice = asNumber(out.slPrice ?? inp.slPrice ?? inp.stopLoss) ?? state.slPrice;
  state.tpPrice = asNumber(out.tpPrice ?? inp.tpPrice ?? inp.takeProfit) ?? state.tpPrice;
  state.bybitRetCode = asNumber(out.retCode ?? out.bybitRetCode) ?? state.bybitRetCode;
  state.bybitRetMsg = asString(out.retMsg ?? out.bybitRetMsg) ?? state.bybitRetMsg;
  state.errorCode = ev.errorCode ?? state.errorCode;
  state.firstSeenAtMs = Math.min(state.firstSeenAtMs, ev.emittedAtMs);
  state.updatedAtMs = Math.max(state.updatedAtMs, ev.emittedAtMs);
  state.expiresAtMs = Math.max(state.expiresAtMs, expiryMs);

  if (classified.field) {
    (state[classified.field] as number | null) = ev.emittedAtMs;
  }
  state.detailsJson = jsonOrNull({ lastMilestone: ev.eventType, message: ev.message, outputSummary: out }) ?? state.detailsJson;

  return state;
}

function buildTradeUpsertStatement(db: D1Database, state: TradeState): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO trade_lifecycle_ledger (
        trade_key, user_id, bot_id, cycle_id, trace_id, environment, symbol, side,
        strategy_id, timeframe, alert_id, intent_id, client_order_id, order_id,
        signal_detected_at_ms, trade_alert_created_at_ms, order_intent_reserved_at_ms,
        order_submit_dispatched_at_ms, bybit_http_ack_at_ms, reconciliation_attempted_at_ms,
        exchange_fill_confirmed_at_ms, exchange_sl_tp_confirmed_at_ms, position_d1_synced_at_ms,
        terminal_failed_at_ms, current_milestone, execution_status,
        requested_qty, requested_price, filled_qty, avg_fill_price, sl_price, tp_price,
        bybit_ret_code, bybit_ret_msg, error_code, first_seen_at_ms, updated_at_ms, expires_at_ms, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trade_key) DO UPDATE SET
        user_id = COALESCE(excluded.user_id, trade_lifecycle_ledger.user_id),
        bot_id = COALESCE(excluded.bot_id, trade_lifecycle_ledger.bot_id),
        cycle_id = COALESCE(excluded.cycle_id, trade_lifecycle_ledger.cycle_id),
        trace_id = COALESCE(excluded.trace_id, trade_lifecycle_ledger.trace_id),
        environment = CASE WHEN excluded.environment != 'unknown' THEN excluded.environment ELSE trade_lifecycle_ledger.environment END,
        side = COALESCE(excluded.side, trade_lifecycle_ledger.side),
        strategy_id = COALESCE(excluded.strategy_id, trade_lifecycle_ledger.strategy_id),
        timeframe = COALESCE(excluded.timeframe, trade_lifecycle_ledger.timeframe),
        alert_id = COALESCE(excluded.alert_id, trade_lifecycle_ledger.alert_id),
        intent_id = COALESCE(excluded.intent_id, trade_lifecycle_ledger.intent_id),
        client_order_id = COALESCE(excluded.client_order_id, trade_lifecycle_ledger.client_order_id),
        order_id = COALESCE(excluded.order_id, trade_lifecycle_ledger.order_id),
        signal_detected_at_ms = COALESCE(trade_lifecycle_ledger.signal_detected_at_ms, excluded.signal_detected_at_ms),
        trade_alert_created_at_ms = COALESCE(trade_lifecycle_ledger.trade_alert_created_at_ms, excluded.trade_alert_created_at_ms),
        order_intent_reserved_at_ms = COALESCE(trade_lifecycle_ledger.order_intent_reserved_at_ms, excluded.order_intent_reserved_at_ms),
        order_submit_dispatched_at_ms = COALESCE(trade_lifecycle_ledger.order_submit_dispatched_at_ms, excluded.order_submit_dispatched_at_ms),
        bybit_http_ack_at_ms = COALESCE(trade_lifecycle_ledger.bybit_http_ack_at_ms, excluded.bybit_http_ack_at_ms),
        reconciliation_attempted_at_ms = COALESCE(excluded.reconciliation_attempted_at_ms, trade_lifecycle_ledger.reconciliation_attempted_at_ms),
        exchange_fill_confirmed_at_ms = COALESCE(trade_lifecycle_ledger.exchange_fill_confirmed_at_ms, excluded.exchange_fill_confirmed_at_ms),
        exchange_sl_tp_confirmed_at_ms = COALESCE(trade_lifecycle_ledger.exchange_sl_tp_confirmed_at_ms, excluded.exchange_sl_tp_confirmed_at_ms),
        position_d1_synced_at_ms = COALESCE(trade_lifecycle_ledger.position_d1_synced_at_ms, excluded.position_d1_synced_at_ms),
        terminal_failed_at_ms = COALESCE(excluded.terminal_failed_at_ms, trade_lifecycle_ledger.terminal_failed_at_ms),
        current_milestone = excluded.current_milestone,
        execution_status = excluded.execution_status,
        requested_qty = COALESCE(excluded.requested_qty, trade_lifecycle_ledger.requested_qty),
        requested_price = COALESCE(excluded.requested_price, trade_lifecycle_ledger.requested_price),
        filled_qty = COALESCE(excluded.filled_qty, trade_lifecycle_ledger.filled_qty),
        avg_fill_price = COALESCE(excluded.avg_fill_price, trade_lifecycle_ledger.avg_fill_price),
        sl_price = COALESCE(excluded.sl_price, trade_lifecycle_ledger.sl_price),
        tp_price = COALESCE(excluded.tp_price, trade_lifecycle_ledger.tp_price),
        bybit_ret_code = COALESCE(excluded.bybit_ret_code, trade_lifecycle_ledger.bybit_ret_code),
        bybit_ret_msg = COALESCE(excluded.bybit_ret_msg, trade_lifecycle_ledger.bybit_ret_msg),
        error_code = COALESCE(excluded.error_code, trade_lifecycle_ledger.error_code),
        first_seen_at_ms = MIN(trade_lifecycle_ledger.first_seen_at_ms, excluded.first_seen_at_ms),
        updated_at_ms = MAX(trade_lifecycle_ledger.updated_at_ms, excluded.updated_at_ms),
        expires_at_ms = MAX(trade_lifecycle_ledger.expires_at_ms, excluded.expires_at_ms),
        details_json = COALESCE(excluded.details_json, trade_lifecycle_ledger.details_json)`
    )
    .bind(
      state.tradeKey,
      state.userId,
      state.botId,
      state.cycleId,
      state.traceId,
      state.environment,
      state.symbol,
      state.side,
      state.strategyId,
      state.timeframe,
      state.alertId,
      state.intentId,
      state.clientOrderId,
      state.orderId,
      state.signalDetectedAtMs,
      state.tradeAlertCreatedAtMs,
      state.orderIntentReservedAtMs,
      state.orderSubmitDispatchedAtMs,
      state.bybitHttpAckAtMs,
      state.reconciliationAttemptedAtMs,
      state.exchangeFillConfirmedAtMs,
      state.exchangeSlTpConfirmedAtMs,
      state.positionD1SyncedAtMs,
      state.terminalFailedAtMs,
      state.currentMilestone,
      state.executionStatus,
      state.requestedQty,
      state.requestedPrice,
      state.filledQty,
      state.avgFillPrice,
      state.slPrice,
      state.tpPrice,
      state.bybitRetCode,
      state.bybitRetMsg,
      state.errorCode,
      state.firstSeenAtMs,
      state.updatedAtMs,
      state.expiresAtMs,
      state.detailsJson
    );
}

interface ParityState {
  correlationKey: string;
  alertId: string | null;
  traceId: string | null;
  cycleId: string | null;
  userId: string | null;
  symbol: string | null;
  strategyId: string | null;
  timeframe: string | null;
  fcmMessageId: string | null;
  androidDeviceSessionHash: string | null;
  backendEventType: string | null;
  backendDispatchedAtMs: number | null;
  fcmHttpStatus: number | null;
  fcmDispatchStatus: string | null;
  backendPayload: Record<string, unknown> | null;
  androidFcmReceivedAtMs: number | null;
  androidPollReceivedAtMs: number | null;
  androidSource: string | null;
  androidDedupOutcome: string | null;
  androidEligibilityOutcome: string | null;
  androidEligibilityReason: string | null;
  androidPostNotifyVerified: number | null;
  androidOsHeadsUpState: string;
  androidValidatedAtMs: number | null;
  androidValidationOutcome: string | null;
  androidValidationReason: string | null;
  androidRenderedAtMs: number | null;
  androidRenderedFields: Record<string, unknown> | null;
  parityStatus: string;
  parityMismatches: string[];
  firstSeenAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function computeParityCorrelationKey(ev: PipelineTelemetryEvent): string {
  const rawKey = ev.alertId || ev.fcmMessageId || ev.clientOrderId || ev.traceId || ev.spanId;
  return ev.userId ? `${ev.userId}:${rawKey}` : rawKey;
}

async function resolveExistingParityState(db: D1Database, ev: PipelineTelemetryEvent): Promise<ParityState | null> {
  const rawKey = ev.alertId || ev.fcmMessageId || ev.clientOrderId || ev.traceId || ev.spanId;
  const scopedKey = computeParityCorrelationKey(ev);
  const userId = ev.userId ?? null;
  const row = await db
    .prepare(
      `SELECT * FROM notification_parity_ledger
       WHERE (
         correlation_key IN (?, ?)
         OR (alert_id IS NOT NULL AND alert_id = ?)
         OR (fcm_message_id IS NOT NULL AND fcm_message_id = ?)
       )
       AND (? IS NULL OR user_id IS NULL OR user_id = ?)
       ORDER BY CASE WHEN user_id = ? THEN 0 WHEN user_id IS NULL THEN 1 ELSE 2 END ASC
       LIMIT 1`
    )
    .bind(
      scopedKey,
      rawKey,
      ev.alertId ?? '__NONE__',
      ev.fcmMessageId ?? '__NONE__',
      userId,
      userId,
      userId
    )
    .first<Record<string, unknown>>();

  if (!row) return null;
  if (row.user_id && ev.userId && String(row.user_id) !== ev.userId) {
    return null;
  }
  let mismatches: string[] = [];
  if (typeof row.parity_mismatches_json === 'string') {
    try {
      const parsed = JSON.parse(row.parity_mismatches_json);
      if (Array.isArray(parsed)) mismatches = parsed.map(String);
    } catch {}
  }

  return {
    correlationKey: String(row.correlation_key),
    alertId: (row.alert_id as string | null) ?? null,
    traceId: (row.trace_id as string | null) ?? null,
    cycleId: (row.cycle_id as string | null) ?? null,
    userId: (row.user_id as string | null) ?? null,
    symbol: (row.symbol as string | null) ?? null,
    strategyId: (row.strategy_id as string | null) ?? null,
    timeframe: (row.timeframe as string | null) ?? null,
    fcmMessageId: (row.fcm_message_id as string | null) ?? null,
    androidDeviceSessionHash: (row.android_device_session_hash as string | null) ?? null,
    backendEventType: (row.backend_event_type as string | null) ?? null,
    backendDispatchedAtMs: asNumber(row.backend_dispatched_at_ms),
    fcmHttpStatus: asNumber(row.fcm_http_status),
    fcmDispatchStatus: (row.fcm_dispatch_status as string | null) ?? null,
    backendPayload: parseJsonObject(row.backend_payload_json),
    androidFcmReceivedAtMs: asNumber(row.android_fcm_received_at_ms),
    androidPollReceivedAtMs: asNumber(row.android_poll_received_at_ms),
    androidSource: (row.android_source as string | null) ?? null,
    androidDedupOutcome: (row.android_dedup_outcome as string | null) ?? null,
    androidEligibilityOutcome: (row.android_eligibility_outcome as string | null) ?? null,
    androidEligibilityReason: (row.android_eligibility_reason as string | null) ?? null,
    androidPostNotifyVerified: asNumber(row.android_post_notify_verified),
    androidOsHeadsUpState: String(row.android_os_heads_up_state || 'UNKNOWN'),
    androidValidatedAtMs: asNumber(row.android_validated_at_ms),
    androidValidationOutcome: (row.android_validation_outcome as string | null) ?? null,
    androidValidationReason: (row.android_validation_reason as string | null) ?? null,
    androidRenderedAtMs: asNumber(row.android_rendered_at_ms),
    androidRenderedFields: parseJsonObject(row.android_rendered_fields_json),
    parityStatus: String(row.parity_status || 'PENDING_ANDROID'),
    parityMismatches: mismatches,
    firstSeenAtMs: Number(row.first_seen_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

function recomputeParity(state: ParityState): void {
  const mismatches: string[] = [];
  const bp = state.backendPayload;
  const ap = state.androidRenderedFields;

  if (bp?.hasPlaceholderPnl3 === true) {
    mismatches.push('DEFECT_PLACEHOLDER_PNL_3');
  }
  if (bp?.hasTimeframe === false && state.backendEventType?.includes('FILL')) {
    mismatches.push('BACKEND_MISSING_TIMEFRAME');
  }

  if (bp && ap) {
    if (bp.symbol && ap.symbol && String(bp.symbol) !== String(ap.symbol)) {
      mismatches.push('FIELD_MISMATCH:symbol');
    }
    if (bp.strategyId && ap.strategyId && String(bp.strategyId) !== String(ap.strategyId)) {
      mismatches.push('FIELD_MISMATCH:strategyId');
    }
    if (bp.timeframe && ap.timeframe && String(bp.timeframe) !== String(ap.timeframe)) {
      mismatches.push('FIELD_MISMATCH:timeframe');
    }
    const bPrice = asNumber(bp.entryPrice ?? bp.price);
    const aPrice = asNumber(ap.entryPrice ?? ap.price);
    if (bPrice !== null && aPrice !== null && Math.abs(bPrice - aPrice) > 1e-6) {
      mismatches.push('FIELD_MISMATCH:entryPrice');
    }
    const bSl = asNumber(bp.stopLossPrice ?? bp.stopLoss);
    const aSl = asNumber(ap.stopLossPrice ?? ap.stopLoss);
    if (bSl !== null && aSl !== null && Math.abs(bSl - aSl) > 1e-6) {
      mismatches.push('FIELD_MISMATCH:stopLossPrice');
    }
    const bTp = asNumber(bp.takeProfitPrice ?? bp.takeProfit);
    const aTp = asNumber(ap.takeProfitPrice ?? ap.takeProfit);
    if (bTp !== null && aTp !== null && Math.abs(bTp - aTp) > 1e-6) {
      mismatches.push('FIELD_MISMATCH:takeProfitPrice');
    }
    const bExec = asBoolean(bp.isExecutable);
    const aExec = asBoolean(ap.isExecutable);
    if (bExec !== null && aExec !== null && bExec !== aExec) {
      mismatches.push('FIELD_MISMATCH:isExecutable');
    }
  }

  if (ap?.rendered === false && !state.androidRenderedAtMs) {
    mismatches.push('ANDROID_POPUP_RENDER_FAILED');
  }

  if (
    state.androidPostNotifyVerified === 0 &&
    !state.androidRenderedAtMs &&
    state.androidEligibilityOutcome !== ANDROID_HEADSUP_STATES.SUPPRESSED_PRECHECK
  ) {
    mismatches.push('ANDROID_POST_CHECK_MISSING');
  }

  state.parityMismatches = Array.from(new Set(mismatches));

  const androidConfirmed = Boolean(
    state.androidRenderedAtMs ||
      state.androidPostNotifyVerified === 1
  );
  const androidAnySignal = Boolean(
    androidConfirmed ||
      state.androidFcmReceivedAtMs ||
      state.androidPollReceivedAtMs ||
      state.androidValidatedAtMs ||
      state.androidDedupOutcome ||
      state.androidEligibilityOutcome
  );

  if (
    (state.fcmDispatchStatus === 'FAILED' || (state.fcmHttpStatus !== null && state.fcmHttpStatus >= 400)) &&
    !androidAnySignal
  ) {
    state.parityStatus = PARITY_STATUSES.FCM_FAILED;
  } else if (
    state.androidEligibilityOutcome === ANDROID_HEADSUP_STATES.SUPPRESSED_PRECHECK ||
    state.androidValidationOutcome === ANDROID_VALIDATION_OUTCOMES.REJECTED ||
    state.androidValidationOutcome === ANDROID_VALIDATION_OUTCOMES.FAILED ||
    state.androidDedupOutcome === ANDROID_DEDUP_DECISIONS.DUPLICATE_DROPPED ||
    (state.androidDedupOutcome === ANDROID_DEDUP_DECISIONS.SUPPRESSED && !androidConfirmed)
  ) {
    state.parityStatus = PARITY_STATUSES.DROPPED_ON_ANDROID;
  } else if (state.parityMismatches.length > 0) {
    state.parityStatus = PARITY_STATUSES.PARITY_MISMATCH;
  } else if (state.backendDispatchedAtMs && androidConfirmed) {
    state.parityStatus = PARITY_STATUSES.PARITY_OK;
  } else if (androidAnySignal && !state.backendDispatchedAtMs) {
    state.parityStatus = PARITY_STATUSES.PENDING_BACKEND;
  } else {
    state.parityStatus = PARITY_STATUSES.PENDING_ANDROID;
  }
}

function mergeParityEventIntoState(
  prev: ParityState | null,
  ev: PipelineTelemetryEvent,
  expiryMs: number
): ParityState {
  const correlationKey = prev?.correlationKey || computeParityCorrelationKey(ev);
  const inp = ev.inputSummary || {};
  const out = ev.outputSummary || {};

  const state: ParityState = prev
    ? { ...prev }
    : {
        correlationKey,
        alertId: ev.alertId ?? null,
        traceId: ev.traceId ?? null,
        cycleId: ev.cycleId ?? null,
        userId: ev.userId ?? null,
        symbol: ev.symbol ?? null,
        strategyId: ev.strategyId ?? null,
        timeframe: ev.timeframe ?? null,
        fcmMessageId: ev.fcmMessageId ?? null,
        androidDeviceSessionHash: ev.androidDeviceSessionHash ?? null,
        backendEventType: null,
        backendDispatchedAtMs: null,
        fcmHttpStatus: null,
        fcmDispatchStatus: null,
        backendPayload: null,
        androidFcmReceivedAtMs: null,
        androidPollReceivedAtMs: null,
        androidSource: null,
        androidDedupOutcome: null,
        androidEligibilityOutcome: null,
        androidEligibilityReason: null,
        androidPostNotifyVerified: null,
        androidOsHeadsUpState: 'UNKNOWN',
        androidValidatedAtMs: null,
        androidValidationOutcome: null,
        androidValidationReason: null,
        androidRenderedAtMs: null,
        androidRenderedFields: null,
        parityStatus: 'PENDING_ANDROID',
        parityMismatches: [],
        firstSeenAtMs: ev.emittedAtMs,
        updatedAtMs: ev.emittedAtMs,
        expiresAtMs: expiryMs,
      };

  state.alertId = state.alertId || ev.alertId || null;
  state.traceId = state.traceId || ev.traceId || null;
  state.cycleId = state.cycleId || ev.cycleId || null;
  state.userId = state.userId || ev.userId || null;
  state.symbol = state.symbol || ev.symbol || null;
  state.strategyId = state.strategyId || ev.strategyId || null;
  state.timeframe = state.timeframe || ev.timeframe || null;
  state.fcmMessageId = state.fcmMessageId || ev.fcmMessageId || asString(out.fcmMessageId);
  state.androidDeviceSessionHash = state.androidDeviceSessionHash || ev.androidDeviceSessionHash || null;
  state.firstSeenAtMs = Math.min(state.firstSeenAtMs, ev.emittedAtMs);
  state.updatedAtMs = Math.max(state.updatedAtMs, ev.emittedAtMs);
  state.expiresAtMs = Math.max(state.expiresAtMs, expiryMs);

  if (ev.stage === 8) {
    state.backendEventType = asString(out.notificationType ?? inp.notificationType) || ev.eventType;
    state.backendDispatchedAtMs = state.backendDispatchedAtMs ?? ev.emittedAtMs;
    state.fcmHttpStatus = asNumber(out.fcmHttpStatus) ?? state.fcmHttpStatus;
    state.fcmDispatchStatus =
      asString(out.fcmDispatchStatus) || (ev.status === 'FAIL' ? 'FAILED' : 'SENT');
    state.backendPayload = {
      ...(state.backendPayload || {}),
      ...out,
      symbol: ev.symbol ?? out.symbol,
      strategyId: ev.strategyId ?? out.strategyId,
      timeframe: ev.timeframe ?? out.timeframe,
    };
  } else if (ev.stage === 9) {
    if (ev.eventType === STAGE9_EVENT_TYPES.FCM_RECEIVED || ev.eventType.includes('FCM_RECEIVED')) {
      state.androidFcmReceivedAtMs = state.androidFcmReceivedAtMs ?? ev.emittedAtMs;
      state.androidSource = state.androidPollReceivedAtMs ? 'BOTH' : 'FCM';
    } else if (ev.eventType === STAGE9_EVENT_TYPES.POLL_RECEIVED || ev.eventType.includes('POLL_RECEIVED')) {
      state.androidPollReceivedAtMs = state.androidPollReceivedAtMs ?? ev.emittedAtMs;
      state.androidSource = state.androidFcmReceivedAtMs ? 'BOTH' : 'POLL_FALLBACK';
    }

    const dedup =
      asString(out.dedupOutcome) ||
      (ev.eventType === STAGE9_EVENT_TYPES.DEDUP_DECISION || ev.eventType.includes('DEDUP')
        ? asString(out.decision)
        : null);
    if (dedup) state.androidDedupOutcome = dedup;

    const rawHeadsUpState = asString(out.androidOsHeadsUpState);
    const notificationsEnabled = asBoolean(out.notificationsEnabled);
    const channelEnabled = asBoolean(out.channelEnabled);
    const headsUpEligible = asBoolean(out.headsUpEligible);
    const channelImportance = asNumber(out.channelImportance);
    const suppressedByOsSettings =
      rawHeadsUpState === ANDROID_HEADSUP_STATES.SUPPRESSED_PRECHECK ||
      notificationsEnabled === false ||
      channelEnabled === false ||
      headsUpEligible === false ||
      channelImportance === 0;

    const elig =
      asString(out.eligibilityOutcome) ||
      (suppressedByOsSettings
        ? ANDROID_HEADSUP_STATES.SUPPRESSED_PRECHECK
        : rawHeadsUpState === ANDROID_HEADSUP_STATES.ELIGIBLE_OS_UNPROVABLE
          ? ANDROID_HEADSUP_STATES.ELIGIBLE_OS_UNPROVABLE
          : null);
    if (elig) {
      state.androidEligibilityOutcome = elig;
      state.androidEligibilityReason =
        asString(out.eligibilityReason) ||
        (ev.eventType === STAGE9_EVENT_TYPES.NOTIFICATION_PRECHECK || ev.eventType.includes('PRECHECK')
          ? asString(out.reason)
          : null) ||
        state.androidEligibilityReason;
      if (elig === ANDROID_HEADSUP_STATES.SUPPRESSED_PRECHECK) {
        state.androidOsHeadsUpState = ANDROID_HEADSUP_STATES.SUPPRESSED_PRECHECK;
      } else if (state.androidOsHeadsUpState === ANDROID_HEADSUP_STATES.UNKNOWN) {
        state.androidOsHeadsUpState = ANDROID_HEADSUP_STATES.ELIGIBLE_OS_UNPROVABLE;
      }
    }

    let postVerified = asBoolean(out.postNotifyVerified);
    if (
      postVerified === null &&
      ev.eventType === STAGE9_LEGACY_EVENT_ALIASES.NOTIF_POSTED_VERIFIED &&
      ev.status === 'PASS'
    ) {
      postVerified = true;
    }
    if (postVerified !== null) {
      state.androidPostNotifyVerified = postVerified ? 1 : 0;
      if (state.androidEligibilityOutcome === ANDROID_HEADSUP_STATES.SUPPRESSED_PRECHECK || suppressedByOsSettings) {
        state.androidOsHeadsUpState = ANDROID_HEADSUP_STATES.SUPPRESSED_PRECHECK;
      } else {
        state.androidOsHeadsUpState = postVerified
          ? ANDROID_HEADSUP_STATES.ELIGIBLE_OS_UNPROVABLE
          : ANDROID_HEADSUP_STATES.POST_CHECK_MISSING;
      }
    }

    const valOutcome =
      asString(out.validationOutcome) ||
      (ev.eventType === STAGE9_EVENT_TYPES.ALERT_VALIDATED || ev.eventType.includes('VALIDATED')
        ? asString(out.outcome)
        : null);
    if (valOutcome || ev.eventType === STAGE9_EVENT_TYPES.ALERT_VALIDATED || ev.eventType.includes('VALIDATED')) {
      state.androidValidatedAtMs = ev.emittedAtMs;
      state.androidValidationOutcome =
        valOutcome || (ev.status === 'FAIL' ? ANDROID_VALIDATION_OUTCOMES.REJECTED : ANDROID_VALIDATION_OUTCOMES.PASS);
      state.androidValidationReason =
        asString(out.validationReason) ||
        (ev.eventType === STAGE9_EVENT_TYPES.ALERT_VALIDATED || ev.eventType.includes('VALIDATED')
          ? asString(out.reason)
          : null) ||
        state.androidValidationReason;
    }

    if (isStage9PopupRenderedEvent(ev)) {
      state.androidRenderedAtMs = state.androidRenderedAtMs ?? ev.emittedAtMs;
      const rendered =
        out.renderedFields && typeof out.renderedFields === 'object'
          ? (out.renderedFields as Record<string, unknown>)
          : out;
      state.androidRenderedFields = {
        ...(state.androidRenderedFields || {}),
        ...rendered,
      };
    } else if (ev.eventType === STAGE9_EVENT_TYPES.POPUP_RENDERED && out.rendered === false) {
      state.androidRenderedFields = {
        ...(state.androidRenderedFields || {}),
        rendered: false,
      };
    }
  }

  recomputeParity(state);
  return state;
}

function buildParityUpsertStatement(db: D1Database, state: ParityState): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO notification_parity_ledger (
        correlation_key, alert_id, trace_id, cycle_id, user_id, symbol, strategy_id, timeframe,
        fcm_message_id, android_device_session_hash,
        backend_event_type, backend_dispatched_at_ms, fcm_http_status, fcm_dispatch_status, backend_payload_json,
        android_fcm_received_at_ms, android_poll_received_at_ms, android_source,
        android_dedup_outcome, android_eligibility_outcome, android_eligibility_reason,
        android_post_notify_verified, android_os_heads_up_state,
        android_validated_at_ms, android_validation_outcome, android_validation_reason,
        android_rendered_at_ms, android_rendered_fields_json,
        parity_status, parity_mismatches_json, first_seen_at_ms, updated_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(correlation_key) DO UPDATE SET
        alert_id = COALESCE(excluded.alert_id, notification_parity_ledger.alert_id),
        trace_id = COALESCE(excluded.trace_id, notification_parity_ledger.trace_id),
        cycle_id = COALESCE(excluded.cycle_id, notification_parity_ledger.cycle_id),
        user_id = COALESCE(excluded.user_id, notification_parity_ledger.user_id),
        symbol = COALESCE(excluded.symbol, notification_parity_ledger.symbol),
        strategy_id = COALESCE(excluded.strategy_id, notification_parity_ledger.strategy_id),
        timeframe = COALESCE(excluded.timeframe, notification_parity_ledger.timeframe),
        fcm_message_id = COALESCE(excluded.fcm_message_id, notification_parity_ledger.fcm_message_id),
        android_device_session_hash = COALESCE(excluded.android_device_session_hash, notification_parity_ledger.android_device_session_hash),
        backend_event_type = COALESCE(excluded.backend_event_type, notification_parity_ledger.backend_event_type),
        backend_dispatched_at_ms = COALESCE(notification_parity_ledger.backend_dispatched_at_ms, excluded.backend_dispatched_at_ms),
        fcm_http_status = COALESCE(excluded.fcm_http_status, notification_parity_ledger.fcm_http_status),
        fcm_dispatch_status = COALESCE(excluded.fcm_dispatch_status, notification_parity_ledger.fcm_dispatch_status),
        backend_payload_json = COALESCE(excluded.backend_payload_json, notification_parity_ledger.backend_payload_json),
        android_fcm_received_at_ms = COALESCE(notification_parity_ledger.android_fcm_received_at_ms, excluded.android_fcm_received_at_ms),
        android_poll_received_at_ms = COALESCE(notification_parity_ledger.android_poll_received_at_ms, excluded.android_poll_received_at_ms),
        android_source = COALESCE(excluded.android_source, notification_parity_ledger.android_source),
        android_dedup_outcome = COALESCE(excluded.android_dedup_outcome, notification_parity_ledger.android_dedup_outcome),
        android_eligibility_outcome = COALESCE(excluded.android_eligibility_outcome, notification_parity_ledger.android_eligibility_outcome),
        android_eligibility_reason = COALESCE(excluded.android_eligibility_reason, notification_parity_ledger.android_eligibility_reason),
        android_post_notify_verified = COALESCE(excluded.android_post_notify_verified, notification_parity_ledger.android_post_notify_verified),
        android_os_heads_up_state = excluded.android_os_heads_up_state,
        android_validated_at_ms = COALESCE(notification_parity_ledger.android_validated_at_ms, excluded.android_validated_at_ms),
        android_validation_outcome = COALESCE(excluded.android_validation_outcome, notification_parity_ledger.android_validation_outcome),
        android_validation_reason = COALESCE(excluded.android_validation_reason, notification_parity_ledger.android_validation_reason),
        android_rendered_at_ms = COALESCE(notification_parity_ledger.android_rendered_at_ms, excluded.android_rendered_at_ms),
        android_rendered_fields_json = COALESCE(excluded.android_rendered_fields_json, notification_parity_ledger.android_rendered_fields_json),
        parity_status = excluded.parity_status,
        parity_mismatches_json = excluded.parity_mismatches_json,
        first_seen_at_ms = MIN(notification_parity_ledger.first_seen_at_ms, excluded.first_seen_at_ms),
        updated_at_ms = MAX(notification_parity_ledger.updated_at_ms, excluded.updated_at_ms),
        expires_at_ms = MAX(notification_parity_ledger.expires_at_ms, excluded.expires_at_ms)`
    )
    .bind(
      state.correlationKey,
      state.alertId,
      state.traceId,
      state.cycleId,
      state.userId,
      state.symbol,
      state.strategyId,
      state.timeframe,
      state.fcmMessageId,
      state.androidDeviceSessionHash,
      state.backendEventType,
      state.backendDispatchedAtMs,
      state.fcmHttpStatus,
      state.fcmDispatchStatus,
      jsonOrNull(state.backendPayload),
      state.androidFcmReceivedAtMs,
      state.androidPollReceivedAtMs,
      state.androidSource,
      state.androidDedupOutcome,
      state.androidEligibilityOutcome,
      state.androidEligibilityReason,
      state.androidPostNotifyVerified,
      state.androidOsHeadsUpState,
      state.androidValidatedAtMs,
      state.androidValidationOutcome,
      state.androidValidationReason,
      state.androidRenderedAtMs,
      jsonOrNull(state.androidRenderedFields),
      state.parityStatus,
      JSON.stringify(state.parityMismatches),
      state.firstSeenAtMs,
      state.updatedAtMs,
      state.expiresAtMs
    );
}

function shouldRecordIncident(ev: PipelineTelemetryEvent): boolean {
  if (ev.status === 'FAIL' || ev.severity === 'ERROR' || ev.severity === 'CRITICAL') return true;
  if (ev.errorCode && ev.status !== 'PASS') return true;
  if (
    ev.eventType.includes('STALE') ||
    ev.eventType.includes('PARITY_MISMATCH') ||
    ev.eventType.includes('TAIL_UNHANDLED')
  ) {
    return true;
  }
  return false;
}

function buildIncidentStatement(db: D1Database, ev: PipelineTelemetryEvent): D1PreparedStatement | null {
  if (!shouldRecordIncident(ev)) return null;
  const fingerprint = computeIncidentFingerprint(ev);
  const expiresAtMs = ev.emittedAtMs + MONITORING_RETENTION_MS.INCIDENTS;
  const userId = ev.userId ?? null;
  const deviceHash = ev.stage === 9 ? (ev.androidDeviceSessionHash ?? null) : null;

  return db
    .prepare(
      `INSERT INTO data_quality_incidents (
        fingerprint, user_id, android_device_session_hash,
        stage, component, event_type, severity, error_code, symbol, strategy_id,
        first_seen_at_ms, last_seen_at_ms, occurrence_count,
        latest_trace_id, latest_cycle_id, latest_discovery_cycle_id,
        latest_message, sample_payload_json, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        user_id = COALESCE(data_quality_incidents.user_id, excluded.user_id),
        android_device_session_hash = COALESCE(excluded.android_device_session_hash, data_quality_incidents.android_device_session_hash),
        severity = CASE
          WHEN excluded.severity = 'CRITICAL' THEN 'CRITICAL'
          WHEN data_quality_incidents.severity = 'CRITICAL' THEN 'CRITICAL'
          ELSE excluded.severity
        END,
        error_code = COALESCE(excluded.error_code, data_quality_incidents.error_code),
        last_seen_at_ms = MAX(data_quality_incidents.last_seen_at_ms, excluded.last_seen_at_ms),
        occurrence_count = data_quality_incidents.occurrence_count + 1,
        latest_trace_id = COALESCE(excluded.latest_trace_id, data_quality_incidents.latest_trace_id),
        latest_cycle_id = COALESCE(excluded.latest_cycle_id, data_quality_incidents.latest_cycle_id),
        latest_discovery_cycle_id = COALESCE(excluded.latest_discovery_cycle_id, data_quality_incidents.latest_discovery_cycle_id),
        latest_message = excluded.latest_message,
        sample_payload_json = COALESCE(excluded.sample_payload_json, data_quality_incidents.sample_payload_json),
        expires_at_ms = MAX(data_quality_incidents.expires_at_ms, excluded.expires_at_ms)`
    )
    .bind(
      fingerprint,
      userId,
      deviceHash,
      ev.stage,
      ev.component,
      ev.eventType,
      ev.severity,
      ev.errorCode ?? null,
      ev.symbol ?? null,
      ev.strategyId ?? null,
      ev.emittedAtMs,
      ev.emittedAtMs,
      ev.traceId ?? null,
      ev.cycleId ?? null,
      ev.discoveryCycleId ?? null,
      ev.message,
      jsonOrNull({
        spanId: ev.spanId,
        inputSummary: ev.inputSummary,
        outputSummary: ev.outputSummary,
      }),
      expiresAtMs
    );
}

/**
 * Ingests a validated TelemetryQueueEnvelope into isolated MONITORING_DB with:
 * - Defense-in-depth sanitization
 * - Exact-once span deduplication & atomic D1 batching
 * - Explicit delivery milestones (CONSUMER_PROCESSED -> D1_COMMITTED)
 * - Out-of-order convergence for Stage 7 Trade Lifecycle & Stage 8/9 Notification Parity
 */
export async function ingestEnvelope(
  db: D1Database,
  envelope: TelemetryQueueEnvelope
): Promise<IngestOutcome> {
  const consumerProcessedAtMs = Date.now();
  const rawEvents = Array.isArray(envelope?.events) ? envelope.events : [];

  const sanitizedById = new Map<string, PipelineTelemetryEvent>();
  for (const raw of rawEvents) {
    const clean = sanitizeTelemetryEvent(raw);
    if (!clean) continue;
    if (!sanitizedById.has(clean.spanId)) {
      sanitizedById.set(clean.spanId, {
        ...clean,
        deliveryMilestone: 'CONSUMER_PROCESSED',
      });
    }
  }

  const uniqueBatchEvents = Array.from(sanitizedById.values());
  const inBatchDupes = rawEvents.length - uniqueBatchEvents.length;

  const existingIds = await fetchExistingSpanIds(
    db,
    uniqueBatchEvents.map((e) => e.spanId)
  );
  const freshEvents = uniqueBatchEvents.filter((e) => !existingIds.has(e.spanId));
  const dbDupes = uniqueBatchEvents.length - freshEvents.length;
  const totalDeduped = Math.max(0, inBatchDupes + dbDupes);

  const stmts: D1PreparedStatement[] = [];
  const pendingTrades = new Map<string, TradeState>();
  const pendingParity = new Map<string, ParityState>();
  let maxEmittedAtMs: number | null = null;
  let totalLag = 0;
  let maxLag = 0;

  for (const ev of freshEvents) {
    const expiryMs = computeExpiryMs(ev);
    const committedAtMs = Date.now();
    maxEmittedAtMs = maxEmittedAtMs === null ? ev.emittedAtMs : Math.max(maxEmittedAtMs, ev.emittedAtMs);
    const lag = Math.max(0, consumerProcessedAtMs - ev.emittedAtMs);
    totalLag += lag;
    if (lag > maxLag) maxLag = lag;

    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO stage_spans (
            span_id, span_group_id, attempt_number, journey, stage, tier, event_type, status, severity,
            environment, user_id, bot_id, discovery_cycle_id, parent_approval_generation, approval_generation,
            cycle_id, trace_id, stage_seq, candle_dataset_id, alert_id, intent_id, client_order_id, order_id,
            fcm_message_id, android_device_session_hash, emitted_at_ms, consumer_processed_at_ms, d1_committed_at_ms,
            duration_ms, delivery_milestone, symbol, timeframe, strategy_id, component, source_file,
            error_code, message, input_summary_json, output_summary_json, metadata_json, expires_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          ev.spanId,
          ev.spanGroupId ?? null,
          ev.attemptNumber ?? null,
          ev.journey,
          ev.stage,
          ev.tier,
          ev.eventType,
          ev.status,
          ev.severity,
          ev.environment,
          ev.userId ?? null,
          ev.botId ?? null,
          ev.discoveryCycleId ?? null,
          ev.parentApprovalGeneration ?? null,
          ev.approvalGeneration ?? null,
          ev.cycleId ?? null,
          ev.traceId ?? null,
          ev.stageSeq,
          ev.candleDatasetId ?? null,
          ev.alertId ?? null,
          ev.intentId ?? null,
          ev.clientOrderId ?? null,
          ev.orderId ?? null,
          ev.fcmMessageId ?? null,
          ev.androidDeviceSessionHash ?? null,
          ev.emittedAtMs,
          consumerProcessedAtMs,
          committedAtMs,
          ev.durationMs ?? null,
          'D1_COMMITTED',
          ev.symbol ?? null,
          ev.timeframe ?? null,
          ev.strategyId ?? null,
          ev.component,
          ev.sourceFile ?? null,
          ev.errorCode ?? null,
          ev.message,
          jsonOrNull(ev.inputSummary),
          jsonOrNull(ev.outputSummary),
          jsonOrNull(ev.metadata),
          expiryMs
        )
    );

    stmts.push(buildCycleUpsertStatement(db, ev, expiryMs));

    const s1 = buildStage1WindowStatement(db, ev, expiryMs);
    if (s1) stmts.push(s1);

    const s2 = buildStage2EligibilityStatement(db, ev, expiryMs);
    if (s2) stmts.push(s2);

    for (const leakStmt of buildDownstreamLeakCheckStatements(db, ev)) {
      stmts.push(leakStmt);
    }

    const s4 = buildStage4TaStatement(db, ev, expiryMs);
    if (s4) stmts.push(s4);

    const s56 = buildGateEvaluationStatement(db, ev, expiryMs);
    if (s56) stmts.push(s56);

    if (isTradeLifecycleEvent(ev)) {
      const tentativeKey = computeTradeKey(ev);
      let baseTrade = pendingTrades.get(tentativeKey) || null;
      if (baseTrade && baseTrade.userId && ev.userId && baseTrade.userId !== ev.userId) {
        baseTrade = null;
      }
      if (!baseTrade) {
        for (const candidate of pendingTrades.values()) {
          const sameUser = !ev.userId || !candidate.userId || candidate.userId === ev.userId;
          if (!sameUser) continue;
          if (
            (ev.clientOrderId && candidate.clientOrderId === ev.clientOrderId) ||
            (ev.intentId && candidate.intentId === ev.intentId) ||
            (ev.orderId && candidate.orderId === ev.orderId) ||
            (ev.alertId && candidate.alertId === ev.alertId)
          ) {
            baseTrade = candidate;
            break;
          }
        }
      }
      if (!baseTrade) {
        baseTrade = await resolveExistingTradeState(db, ev);
      }
      const nextTrade = mergeTradeEventIntoState(baseTrade, ev, expiryMs);
      pendingTrades.set(nextTrade.tradeKey, nextTrade);
    }

    if (ev.stage === 8 || ev.stage === 9) {
      const tentativeKey = computeParityCorrelationKey(ev);
      let baseParity = pendingParity.get(tentativeKey) || null;
      if (baseParity && baseParity.userId && ev.userId && baseParity.userId !== ev.userId) {
        baseParity = null;
      }
      if (!baseParity) {
        for (const candidate of pendingParity.values()) {
          const sameUser = !ev.userId || !candidate.userId || candidate.userId === ev.userId;
          if (!sameUser) continue;
          if (
            (ev.alertId && candidate.alertId === ev.alertId) ||
            (ev.fcmMessageId && candidate.fcmMessageId === ev.fcmMessageId)
          ) {
            baseParity = candidate;
            break;
          }
        }
      }
      if (!baseParity) {
        baseParity = await resolveExistingParityState(db, ev);
      }
      const nextParity = mergeParityEventIntoState(baseParity, ev, expiryMs);
      pendingParity.set(nextParity.correlationKey, nextParity);
    }

    const incStmt = buildIncidentStatement(db, ev);
    if (incStmt) stmts.push(incStmt);
  }

  for (const tradeState of pendingTrades.values()) {
    stmts.push(buildTradeUpsertStatement(db, tradeState));
  }
  for (const parityState of pendingParity.values()) {
    stmts.push(buildParityUpsertStatement(db, parityState));
  }

  const d1CommittedAtMs = Date.now();
  const avgBatchLag = freshEvents.length > 0 ? totalLag / freshEvents.length : 0;

  stmts.push(
    db
      .prepare(
        `INSERT INTO monitoring_self_health (
          metric_key, events_received, events_inserted, events_deduped, dlq_routed, d1_write_errors,
          last_event_emitted_at_ms, last_consumer_processed_at_ms, last_d1_committed_at_ms,
          avg_ingest_lag_ms, max_ingest_lag_ms, last_error, producer_stats_json, updated_at_ms
        ) VALUES ('consumer_global', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, NULL, NULL, ?)
        ON CONFLICT(metric_key) DO UPDATE SET
          events_received = monitoring_self_health.events_received + excluded.events_received,
          events_inserted = monitoring_self_health.events_inserted + excluded.events_inserted,
          events_deduped = monitoring_self_health.events_deduped + excluded.events_deduped,
          last_event_emitted_at_ms = CASE
            WHEN excluded.last_event_emitted_at_ms IS NULL THEN monitoring_self_health.last_event_emitted_at_ms
            WHEN monitoring_self_health.last_event_emitted_at_ms IS NULL THEN excluded.last_event_emitted_at_ms
            ELSE MAX(monitoring_self_health.last_event_emitted_at_ms, excluded.last_event_emitted_at_ms)
          END,
          last_consumer_processed_at_ms = excluded.last_consumer_processed_at_ms,
          last_d1_committed_at_ms = excluded.last_d1_committed_at_ms,
          avg_ingest_lag_ms = CASE
            WHEN excluded.events_inserted > 0 THEN ROUND((monitoring_self_health.avg_ingest_lag_ms * 0.7) + (excluded.avg_ingest_lag_ms * 0.3), 2)
            ELSE monitoring_self_health.avg_ingest_lag_ms
          END,
          max_ingest_lag_ms = MAX(monitoring_self_health.max_ingest_lag_ms, excluded.max_ingest_lag_ms),
          updated_at_ms = excluded.updated_at_ms`
      )
      .bind(
        rawEvents.length,
        freshEvents.length,
        totalDeduped,
        maxEmittedAtMs,
        consumerProcessedAtMs,
        d1CommittedAtMs,
        avgBatchLag,
        maxLag,
        d1CommittedAtMs
      )
  );

  if (envelope?.producer) {
    const producerKey = `producer:${scrubSensitiveString(String(envelope.producer)).slice(0, 48)}`;
    stmts.push(
      db
        .prepare(
          `INSERT INTO monitoring_self_health (
            metric_key, events_received, events_inserted, events_deduped, dlq_routed, d1_write_errors,
            last_event_emitted_at_ms, last_consumer_processed_at_ms, last_d1_committed_at_ms,
            avg_ingest_lag_ms, max_ingest_lag_ms, last_error, producer_stats_json, updated_at_ms
          ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(metric_key) DO UPDATE SET
            events_received = monitoring_self_health.events_received + excluded.events_received,
            events_inserted = monitoring_self_health.events_inserted + excluded.events_inserted,
            events_deduped = monitoring_self_health.events_deduped + excluded.events_deduped,
            last_event_emitted_at_ms = CASE
              WHEN excluded.last_event_emitted_at_ms IS NULL THEN monitoring_self_health.last_event_emitted_at_ms
              WHEN monitoring_self_health.last_event_emitted_at_ms IS NULL THEN excluded.last_event_emitted_at_ms
              ELSE MAX(monitoring_self_health.last_event_emitted_at_ms, excluded.last_event_emitted_at_ms)
            END,
            last_consumer_processed_at_ms = excluded.last_consumer_processed_at_ms,
            last_d1_committed_at_ms = excluded.last_d1_committed_at_ms,
            producer_stats_json = COALESCE(excluded.producer_stats_json, monitoring_self_health.producer_stats_json),
            updated_at_ms = excluded.updated_at_ms`
        )
        .bind(
          producerKey,
          rawEvents.length,
          freshEvents.length,
          totalDeduped,
          maxEmittedAtMs,
          consumerProcessedAtMs,
          d1CommittedAtMs,
          avgBatchLag,
          maxLag,
          jsonOrNull(envelope.producerStats),
          d1CommittedAtMs
        )
    );
  }

  if (stmts.length > 0) {
    await db.batch(stmts);
  }

  return {
    batchId: envelope?.batchId || 'unknown',
    received: rawEvents.length,
    inserted: freshEvents.length,
    deduped: totalDeduped,
    dlqRouted: 0,
    consumerProcessedAtMs,
    d1CommittedAtMs,
  };
}

async function recordD1WriteFailureBestEffort(db: D1Database, errorMessage: string): Promise<void> {
  const now = Date.now();
  const safeErr = scrubSensitiveString(errorMessage).slice(0, 300);
  try {
    await db
      .prepare(
        `INSERT INTO monitoring_self_health (
          metric_key, events_received, events_inserted, events_deduped, dlq_routed, d1_write_errors,
          last_error, updated_at_ms
        ) VALUES ('consumer_global', 0, 0, 0, 0, 1, ?, ?)
        ON CONFLICT(metric_key) DO UPDATE SET
          d1_write_errors = monitoring_self_health.d1_write_errors + 1,
          last_error = excluded.last_error,
          updated_at_ms = excluded.updated_at_ms`
      )
      .bind(safeErr, now)
      .run();
  } catch {
    // Best-effort only: D1 itself may be unavailable.
  }
}

export async function handleQueueBatch(
  batch: TelemetryQueueBatch,
  env: MonitoringEnv
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await ingestEnvelope(env.MONITORING_DB, message.body);
      message.ack();
    } catch (err: any) {
      await recordD1WriteFailureBestEffort(env.MONITORING_DB, err?.message || 'ingest_failed');
      message.retry();
    }
  }
}

export async function handleDlqBatch(
  batch: TelemetryQueueBatch,
  env: MonitoringEnv
): Promise<void> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  let messageCount = 0;

  for (const message of batch.messages) {
    messageCount += 1;
    const body = message.body as Partial<TelemetryQueueEnvelope> | undefined;
    const events = Array.isArray(body?.events) ? body!.events : [];
    const dlqId = generateSpanId('dlq');
    const preview = jsonOrNull(
      events.slice(0, 3).map((e) => ({
        spanId: e?.spanId,
        stage: e?.stage,
        eventType: e?.eventType,
        symbol: e?.symbol,
        deliveryMilestone: 'ROUTED_TO_DLQ',
      }))
    );

    stmts.push(
      env.MONITORING_DB.prepare(
        `INSERT OR IGNORE INTO telemetry_dlq_records (
          dlq_id, batch_id, producer, event_count, failure_reason, retry_attempts,
          received_at_ms, expires_at_ms, raw_preview_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        dlqId,
        body?.batchId ? String(body.batchId).slice(0, 80) : null,
        body?.producer ? String(body.producer).slice(0, 64) : 'unknown',
        events.length,
        'MAX_QUEUE_RETRIES_EXCEEDED',
        typeof message.attempts === 'number' ? message.attempts : 3,
        now,
        now + MONITORING_RETENTION_MS.DLQ_RECORDS,
        preview
      )
    );
  }

  if (messageCount > 0) {
    stmts.push(
      env.MONITORING_DB.prepare(
        `INSERT INTO monitoring_self_health (
          metric_key, events_received, events_inserted, events_deduped, dlq_routed, d1_write_errors, updated_at_ms
        ) VALUES ('consumer_global', 0, 0, 0, ?, 0, ?)
        ON CONFLICT(metric_key) DO UPDATE SET
          dlq_routed = monitoring_self_health.dlq_routed + excluded.dlq_routed,
          updated_at_ms = excluded.updated_at_ms`
      ).bind(messageCount, now)
    );
  }

  try {
    if (stmts.length > 0) {
      await env.MONITORING_DB.batch(stmts);
    }
    for (const message of batch.messages) {
      message.ack();
    }
  } catch (err: any) {
    await recordD1WriteFailureBestEffort(env.MONITORING_DB, err?.message || 'dlq_persist_failed');
    for (const message of batch.messages) {
      message.retry();
    }
  }
}

const RETENTION_TABLES = [
  'stage_spans',
  'pipeline_cycles',
  'stage2_eligibility_decisions',
  'ta_indicator_snapshots',
  'gate_evaluations',
  'trade_lifecycle_ledger',
  'notification_parity_ledger',
  'exchange_health_windows',
  'data_quality_incidents',
  'telemetry_dlq_records',
] as const;

export async function pruneExpiredTelemetry(
  db: D1Database,
  nowMs = Date.now()
): Promise<Record<string, number>> {
  const deletedByTable: Record<string, number> = {};
  const results = await db.batch(
    RETENTION_TABLES.map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE expires_at_ms < ?`).bind(nowMs)
    )
  );

  for (let i = 0; i < RETENTION_TABLES.length; i++) {
    const table = RETENTION_TABLES[i];
    deletedByTable[table] = Number(results[i]?.meta?.changes ?? 0);
  }
  return deletedByTable;
}
