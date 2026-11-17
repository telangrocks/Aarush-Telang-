import { PARITY_STATUSES } from '../../shared/monitoring';
import { isExpectedSafetyGateBlockEvent, isStaleApprovalExpiryEvent } from './consumer';
import { AdminPrincipal, MonitoringEnv } from './types';

export interface QueryResult {
  status: number;
  body: Record<string, unknown>;
}

interface TenantScope {
  isOperator: boolean;
  userId: string | null;
  deviceSessionHash: string | null;
}

function resolveTenantScope(
  url: URL,
  principal: AdminPrincipal
): { ok: true; scope: TenantScope } | { ok: false; res: QueryResult } {
  const requestedUserId = cleanParam(url.searchParams.get('userId'));
  const requestedDevice = cleanParam(
    url.searchParams.get('deviceSessionHash') || url.searchParams.get('androidDeviceSessionHash')
  );

  if (principal.scope === 'OPERATOR') {
    return {
      ok: true,
      scope: {
        isOperator: true,
        userId: requestedUserId,
        deviceSessionHash: requestedDevice,
      },
    };
  }

  if (!principal.userId) {
    return { ok: false, res: { status: 403, body: { error: 'Forbidden: monitoring token missing user identity' } } };
  }
  if (requestedUserId && requestedUserId !== principal.userId) {
    return { ok: false, res: { status: 403, body: { error: 'Forbidden: cross-user monitoring query denied' } } };
  }
  if (requestedDevice && principal.deviceSessionHash && requestedDevice !== principal.deviceSessionHash) {
    return { ok: false, res: { status: 403, body: { error: 'Forbidden: cross-device monitoring query denied' } } };
  }

  return {
    ok: true,
    scope: {
      isOperator: false,
      userId: principal.userId,
      deviceSessionHash: principal.deviceSessionHash ?? requestedDevice ?? null,
    },
  };
}

interface FilterItem {
  sql: string;
  value?: string | number | null;
  binds?: Array<string | number>;
}

function buildWhereClause(filters: FilterItem[]): {
  whereSql: string;
  params: Array<string | number>;
} {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  for (const f of filters) {
    if (Array.isArray(f.binds)) {
      clauses.push(f.sql);
      params.push(...f.binds);
    } else if (f.value !== null && f.value !== undefined && f.value !== '') {
      clauses.push(f.sql);
      params.push(f.value);
    }
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function addStage9DeviceFilter(filters: FilterItem[], deviceSessionHash: string | null, colPrefix = ''): void {
  if (!deviceSessionHash) return;
  const p = colPrefix ? `${colPrefix}.` : '';
  filters.push({
    sql: `(${p}stage != 9 OR ${p}android_device_session_hash = ?)`,
    binds: [deviceSessionHash],
  });
}

function addNotificationDeviceFilter(filters: FilterItem[], scope: TenantScope, colPrefix = ''): void {
  if (!scope.deviceSessionHash) return;
  const p = colPrefix ? `${colPrefix}.` : '';
  if (scope.isOperator) {
    filters.push({ sql: `${p}android_device_session_hash = ?`, binds: [scope.deviceSessionHash] });
    return;
  }
  filters.push({
    sql: `(${p}android_device_session_hash = ? OR (${p}android_device_session_hash IS NULL AND ${p}android_fcm_received_at_ms IS NULL AND ${p}android_poll_received_at_ms IS NULL AND ${p}android_rendered_at_ms IS NULL))`,
    binds: [scope.deviceSessionHash],
  });
}

interface StageDefinition {
  stage: number;
  name: string;
  shortName: string;
  staleThresholdMs: number;
}

const STAGE_CATALOG: StageDefinition[] = [
  { stage: 1, name: 'Bybit Connectivity & Raw Market Data', shortName: 'Connectivity & Data', staleThresholdMs: 180_000 },
  { stage: 2, name: 'Budget & Symbol Eligibility', shortName: 'Budget & Eligibility', staleThresholdMs: 300_000 },
  { stage: 3, name: 'Historical Candle Retrieval & Validation', shortName: 'Candle Validation', staleThresholdMs: 180_000 },
  { stage: 4, name: 'Technical Analysis & Regime', shortName: 'TA & Regime', staleThresholdMs: 180_000 },
  { stage: 5, name: 'Autonomous Strategy Evaluation', shortName: 'Strategies', staleThresholdMs: 180_000 },
  { stage: 6, name: 'Safety Gates, Lifecycle & Execution Prep', shortName: 'Safety Gates', staleThresholdMs: 300_000 },
  { stage: 7, name: 'Order Dispatch, Reconciliation & D1 Sync', shortName: 'Order Lifecycle', staleThresholdMs: 600_000 },
  { stage: 8, name: 'Backend Notifications & FCM Dispatch', shortName: 'FCM Dispatch', staleThresholdMs: 600_000 },
  { stage: 9, name: 'Android Telemetry, Dedup & Popup Parity', shortName: 'Android Parity', staleThresholdMs: 600_000 },
];

const DEAD_UNWIRED_COMPONENTS = [
  {
    name: 'ValidationPipeline',
    sourceFile: 'backend/src/engine/validation/ValidationPipeline.ts',
    status: '[NOT_IN_LIVE_PATH]',
    reason:
      'Legacy/offline validator not invoked during live TradingBot execution; live validation uses ExecutionEligibilityGate, TradeValidator, and FinalDispatchSafetyGate.',
  },
  {
    name: 'TradingSafetyEngine',
    sourceFile: 'backend/src/engine/safety/TradingSafetyEngine.ts',
    status: '[NOT_IN_LIVE_PATH]',
    reason:
      'Unwired candidate safety module not invoked in live autonomous loop; live enforcement runs via TradingBot inline safety gates, Fence A, and Fence B.',
  },
];

function parseBoundInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function safeJsonParse(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asNullableNumber(val: unknown): number | null {
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
}

function cleanParam(val: string | null): string | null {
  if (!val) return null;
  const trimmed = val.trim();
  return trimmed ? trimmed.slice(0, 128) : null;
}

function deriveHonestStageState(params: {
  total: number;
  failCount: number;
  warnCount: number;
  passCount: number;
  latestStatus: string | null;
  latestEmittedAtMs: number | null;
  nowMs: number;
  staleThresholdMs: number;
}): 'DISCONNECTED' | 'FAIL' | 'STALE' | 'DEGRADED' | 'SKIPPED' | 'HEALTHY' {
  if (params.total === 0 || params.latestEmittedAtMs == null) return 'DISCONNECTED';
  if (params.latestStatus === 'FAIL' || params.failCount > 0) return 'FAIL';
  if (params.nowMs - params.latestEmittedAtMs > params.staleThresholdMs) return 'STALE';
  if (params.latestStatus === 'WARN' || params.warnCount > 0) return 'DEGRADED';
  if (params.latestStatus === 'SKIPPED' && params.passCount === 0) return 'SKIPPED';
  return 'HEALTHY';
}

function mapSpanRow(r: any): Record<string, unknown> {
  const inputSummary = safeJsonParse(r.input_summary_json) as Record<string, unknown> | null;
  const outputSummary = safeJsonParse(r.output_summary_json) as Record<string, unknown> | null;
  const isStaleApproval = isStaleApprovalExpiryEvent({
    stage: Number(r.stage),
    eventType: r.event_type,
    errorCode: r.error_code,
    message: r.message,
    outputSummary,
  });
  const isExpectedSafetyBlock = isExpectedSafetyGateBlockEvent({
    stage: Number(r.stage),
    eventType: r.event_type,
    errorCode: r.error_code,
    message: r.message,
    outputSummary,
  });
  const monitoringClassification = isStaleApproval
    ? 'APPROVAL_EXPIRED_STALE'
    : isExpectedSafetyBlock
      ? 'EXPECTED_SAFETY_BLOCK'
      : null;

  return {
    spanId: r.span_id,
    spanGroupId: r.span_group_id ?? null,
    attemptNumber: r.attempt_number ?? null,
    journey: r.journey,
    stage: r.stage,
    tier: r.tier,
    eventType: r.event_type,
    status: r.status,
    monitoringClassification,
    severity: r.severity,
    environment: r.environment,
    userId: r.user_id ?? null,
    botId: r.bot_id ?? null,
    discoveryCycleId: r.discovery_cycle_id ?? null,
    parentApprovalGeneration: r.parent_approval_generation ?? null,
    approvalGeneration: r.approval_generation ?? null,
    cycleId: r.cycle_id ?? null,
    traceId: r.trace_id ?? null,
    stageSeq: r.stage_seq ?? 0,
    candleDatasetId: r.candle_dataset_id ?? null,
    alertId: r.alert_id ?? null,
    intentId: r.intent_id ?? null,
    clientOrderId: r.client_order_id ?? null,
    orderId: r.order_id ?? null,
    fcmMessageId: r.fcm_message_id ?? null,
    androidDeviceSessionHash: r.android_device_session_hash ?? null,
    emittedAtMs: r.emitted_at_ms,
    consumerProcessedAtMs: r.consumer_processed_at_ms,
    d1CommittedAtMs: r.d1_committed_at_ms,
    durationMs: asNullableNumber(r.duration_ms),
    deliveryMilestone: r.delivery_milestone,
    symbol: r.symbol ?? null,
    timeframe: r.timeframe ?? null,
    strategyId: r.strategy_id ?? null,
    component: r.component,
    sourceFile: r.source_file ?? null,
    errorCode: r.error_code ?? null,
    message: r.message,
    inputSummary,
    outputSummary,
    metadata: safeJsonParse(r.metadata_json),
  };
}

function mapCycleRow(r: any): Record<string, unknown> {
  const rawFailureCode = String(r.failure_code || '').toUpperCase();
  const isStaleApprovalCycle =
    Number(r.failed_stage) === 2 &&
    (rawFailureCode === 'APPROVAL_EXPIRED_OR_INVALID' || rawFailureCode.includes('APPROVAL_EXPIRED'));
  const isExpectedSafetyBlockCycle =
    Number(r.failed_stage) === 6 &&
    (rawFailureCode === 'REGIME_PROHIBITED' ||
      rawFailureCode === 'HTF_CONFLICT' ||
      String(r.failure_summary || '').toUpperCase().includes('REGIME_PROHIBITED') ||
      String(r.failure_summary || '').toUpperCase().includes('HTF_CONFLICT'));

  const overallStatus = isStaleApprovalCycle
    ? 'STALE'
    : isExpectedSafetyBlockCycle
      ? 'PASS'
      : r.overall_status;
  const statusClassification = isStaleApprovalCycle
    ? 'APPROVAL_EXPIRED_STALE'
    : isExpectedSafetyBlockCycle
      ? 'EXPECTED_SAFETY_BLOCK'
      : null;

  return {
    traceKey: r.trace_key,
    journey: r.journey,
    environment: r.environment,
    userId: r.user_id ?? null,
    botId: r.bot_id ?? null,
    discoveryCycleId: r.discovery_cycle_id ?? null,
    approvalGeneration: r.approval_generation ?? null,
    parentApprovalGeneration: r.parent_approval_generation ?? null,
    cycleId: r.cycle_id ?? null,
    traceId: r.trace_id ?? null,
    startedAtMs: r.started_at_ms,
    updatedAtMs: r.updated_at_ms,
    expiresAtMs: r.expires_at_ms,
    overallStatus,
    statusClassification,
    furthestStage: r.furthest_stage,
    failedStage: isStaleApprovalCycle || isExpectedSafetyBlockCycle ? null : (r.failed_stage ?? null),
    failureCode: r.failure_code ?? null,
    failureSummary: r.failure_summary ?? null,
    symbolsCount: r.symbols_count ?? 0,
    acceptedCount: r.accepted_count ?? 0,
    signalsCount: r.signals_count ?? 0,
    ordersCount: r.orders_count ?? 0,
    fcmSentCount: r.fcm_sent_count ?? 0,
    androidConfirmedCount: r.android_confirmed_count ?? 0,
    metadata: safeJsonParse(r.metadata_json),
  };
}

function mapTradeRow(r: any): Record<string, unknown> {
  const bybitHttpAckAtMs = r.bybit_http_ack_at_ms ?? null;
  const exchangeFillConfirmedAtMs = r.exchange_fill_confirmed_at_ms ?? null;
  const exchangeSlTpConfirmedAtMs = r.exchange_sl_tp_confirmed_at_ms ?? null;
  const positionD1SyncedAtMs = r.position_d1_synced_at_ms ?? null;
  const rawMilestone = String(r.current_milestone || '');
  const rawStatus = String(r.execution_status || '');
  const rawDetails = safeJsonParse(r.details_json) as Record<string, any> | null;

  const isFcmMilestone =
    rawMilestone.startsWith('FCM_') ||
    rawMilestone.startsWith('NOTIFICATION_') ||
    String(r.error_code || '') === 'NO_FCM_CREDENTIALS';
  const hasFillConfirmation = Boolean(exchangeFillConfirmedAtMs);

  // Priority 1: Keep trade execution status and notification status separate.
  // A confirmed Bybit fill must never be displayed as an execution failure because push delivery failed.
  let executionStatus = rawStatus;
  let currentMilestone = rawMilestone;
  let terminalFailedAtMs = r.terminal_failed_at_ms ?? null;
  let executionErrorCode = r.error_code ?? null;
  let notificationStatus: string | null =
    typeof rawDetails?.notificationStatus === 'string' ? rawDetails.notificationStatus : null;
  let notificationErrorCode: string | null =
    typeof rawDetails?.notificationErrorCode === 'string' ? rawDetails.notificationErrorCode : null;

  if (isFcmMilestone) {
    notificationStatus =
      notificationStatus || (rawMilestone.includes('FAILED') || rawStatus === 'FAILED' ? 'FCM_FAILED' : 'SENT');
    notificationErrorCode = notificationErrorCode || (r.error_code ?? null);
  }

  if (hasFillConfirmation && (rawStatus === 'FAILED' || isFcmMilestone)) {
    executionStatus = positionD1SyncedAtMs || exchangeSlTpConfirmedAtMs ? 'PROTECTED' : 'FILL_CONFIRMED';
    currentMilestone = positionD1SyncedAtMs
      ? 'POSITION_D1_SYNCED'
      : exchangeSlTpConfirmedAtMs
        ? 'EXCHANGE_SL_TP_CONFIRMED'
        : 'EXCHANGE_FILL_CONFIRMED';
    terminalFailedAtMs = null;
    if (isFcmMilestone) {
      executionErrorCode = null;
    }
  }

  // Priority 7: Stage 7 close visibility — display verified close data if present; otherwise report telemetry limitation without inventing PnL.
  const outSummary =
    rawDetails?.outputSummary && typeof rawDetails.outputSummary === 'object'
      ? (rawDetails.outputSummary as Record<string, any>)
      : null;
  const closedAtMs = asNullableNumber(rawDetails?.closedAtMs ?? rawDetails?.positionClosedAtMs ?? outSummary?.closedAtMs);
  const exitPrice = asNullableNumber(rawDetails?.exitPrice ?? rawDetails?.closePrice ?? outSummary?.exitPrice);
  const realizedPnl = asNullableNumber(rawDetails?.realizedPnl ?? outSummary?.realizedPnl);
  const closeReason =
    typeof rawDetails?.closeReason === 'string'
      ? rawDetails.closeReason
      : typeof outSummary?.closeReason === 'string'
        ? outSummary.closeReason
        : null;
  const closeRecorded = Boolean(closedAtMs !== null || exitPrice !== null || rawMilestone === 'POSITION_CLOSED');

  const closeTelemetry = closeRecorded
    ? {
        closeRecorded: true,
        status: 'CLOSED_VERIFIED',
        closedAtMs,
        exitPrice,
        realizedPnl,
        closeReason,
        limitationNote: null,
      }
    : {
        closeRecorded: false,
        status: 'CLOSE_TELEMETRY_NOT_EMITTED_BY_PRODUCER',
        closedAtMs: null,
        exitPrice: null,
        realizedPnl: null,
        closeReason: null,
        limitationNote:
          'Producer (TradingBot) emits Stage 7 spans through POSITION_D1_SYNCED (open sync) and does not emit POSITION_CLOSED spans to monitoring; close price and realized PnL are not available in Stage 7 telemetry.',
      };

  return {
    tradeKey: r.trade_key,
    userId: r.user_id ?? null,
    botId: r.bot_id ?? null,
    cycleId: r.cycle_id ?? null,
    traceId: r.trace_id ?? null,
    environment: r.environment,
    symbol: r.symbol,
    side: r.side ?? null,
    strategyId: r.strategy_id ?? null,
    timeframe: r.timeframe ?? null,
    alertId: r.alert_id ?? null,
    intentId: r.intent_id ?? null,
    clientOrderId: r.client_order_id ?? null,
    orderId: r.order_id ?? null,
    currentMilestone,
    executionStatus,
    notificationStatus,
    notificationErrorCode,
    isAckOnly: Boolean(bybitHttpAckAtMs && !exchangeFillConfirmedAtMs),
    hasFillConfirmation,
    hasProtectionConfirmed: Boolean(exchangeSlTpConfirmedAtMs || positionD1SyncedAtMs),
    requestedQty: asNullableNumber(r.requested_qty),
    requestedPrice: asNullableNumber(r.requested_price),
    filledQty: asNullableNumber(r.filled_qty),
    avgFillPrice: asNullableNumber(r.avg_fill_price),
    slPrice: asNullableNumber(r.sl_price),
    tpPrice: asNullableNumber(r.tp_price),
    bybitRetCode: r.bybit_ret_code ?? null,
    bybitRetMsg: r.bybit_ret_msg ?? null,
    errorCode: executionErrorCode,
    milestones: {
      signalDetectedAtMs: r.signal_detected_at_ms ?? null,
      tradeAlertCreatedAtMs: r.trade_alert_created_at_ms ?? null,
      orderIntentReservedAtMs: r.order_intent_reserved_at_ms ?? null,
      orderSubmitDispatchedAtMs: r.order_submit_dispatched_at_ms ?? null,
      bybitHttpAckAtMs,
      reconciliationAttemptedAtMs: r.reconciliation_attempted_at_ms ?? null,
      exchangeFillConfirmedAtMs,
      exchangeSlTpConfirmedAtMs,
      positionD1SyncedAtMs,
      terminalFailedAtMs,
      closedAtMs,
    },
    closeTelemetry,
    firstSeenAtMs: r.first_seen_at_ms,
    updatedAtMs: r.updated_at_ms,
    details: rawDetails,
  };
}

function mapNotificationRow(r: any): Record<string, unknown> {
  const ck = String(r.correlation_key || '');
  const backendEventType = r.backend_event_type ?? null;
  const isFillRecord =
    ck.endsWith(':TRADE_FILLED') || String(backendEventType || '').toUpperCase() === 'TRADE_FILLED';
  const notificationCategory = isFillRecord ? 'TRADE_FILLED' : 'TRADE_ALERT';
  const fcmDispatchStatus = r.fcm_dispatch_status ?? null;
  const fcmDeliveryStatus =
    fcmDispatchStatus === 'FAILED'
      ? 'FCM_FAILED'
      : fcmDispatchStatus === 'SENT'
        ? 'FCM_SENT'
        : 'NOT_DISPATCHED';

  const androidPostNotifyVerified =
    r.android_post_notify_verified === null || r.android_post_notify_verified === undefined
      ? null
      : Boolean(r.android_post_notify_verified);
  const androidConfirmed = Boolean(r.android_rendered_at_ms || androidPostNotifyVerified === true);
  const androidSource = r.android_source ?? null;
  const androidDeliveryStatus = isFillRecord && !androidConfirmed
    ? 'NOT_APPLICABLE_FILL_NOTIFICATION'
    : androidConfirmed
      ? androidSource === 'POLL_FALLBACK'
        ? 'DELIVERED_VIA_POLL_FALLBACK'
        : androidSource === 'BOTH'
          ? 'DELIVERED_FCM_AND_POLL'
          : 'DELIVERED_VIA_FCM'
      : r.android_poll_received_at_ms || r.android_fcm_received_at_ms
        ? 'RECEIVED_PENDING_RENDER'
        : 'NOT_RECEIVED';

  return {
    correlationKey: r.correlation_key,
    alertId: r.alert_id ?? null,
    notificationCategory,
    traceId: r.trace_id ?? null,
    cycleId: r.cycle_id ?? null,
    userId: r.user_id ?? null,
    symbol: r.symbol ?? null,
    strategyId: r.strategy_id ?? null,
    timeframe: r.timeframe ?? null,
    fcmMessageId: r.fcm_message_id ?? null,
    androidDeviceSessionHash: r.android_device_session_hash ?? null,
    backendEventType,
    backendDispatchedAtMs: r.backend_dispatched_at_ms ?? null,
    fcmHttpStatus: r.fcm_http_status ?? null,
    fcmDispatchStatus,
    fcmDeliveryStatus,
    backendPayload: safeJsonParse(r.backend_payload_json),
    androidFcmReceivedAtMs: r.android_fcm_received_at_ms ?? null,
    androidPollReceivedAtMs: r.android_poll_received_at_ms ?? null,
    androidSource,
    androidDeliveryStatus,
    androidDedupOutcome: r.android_dedup_outcome ?? null,
    androidEligibilityOutcome: r.android_eligibility_outcome ?? null,
    androidEligibilityReason: r.android_eligibility_reason ?? null,
    androidPostNotifyVerified,
    androidOsHeadsUpState: r.android_os_heads_up_state || 'UNKNOWN',
    androidValidatedAtMs: r.android_validated_at_ms ?? null,
    androidValidationOutcome: r.android_validation_outcome ?? null,
    androidValidationReason: r.android_validation_reason ?? null,
    androidRenderedAtMs: r.android_rendered_at_ms ?? null,
    androidRenderedFields: safeJsonParse(r.android_rendered_fields_json),
    parityStatus: r.parity_status,
    parityMismatches: safeJsonParse(r.parity_mismatches_json) || [],
    firstSeenAtMs: r.first_seen_at_ms,
    updatedAtMs: r.updated_at_ms,
  };
}

function mapTaRow(r: any): Record<string, unknown> {
  const indicators = {
    rsi: asNullableNumber(r.rsi),
    ema9: asNullableNumber(r.ema9),
    ema21: asNullableNumber(r.ema21),
    ema50: asNullableNumber(r.ema50),
    ema200: asNullableNumber(r.ema200),
    macdLine: asNullableNumber(r.macd_line),
    macdSignal: asNullableNumber(r.macd_signal),
    macdHist: asNullableNumber(r.macd_hist),
    adx: asNullableNumber(r.adx),
    atr: asNullableNumber(r.atr),
    vwap: asNullableNumber(r.vwap),
    vwapDistancePct: asNullableNumber(r.vwap_distance_pct),
    bbUpper: asNullableNumber(r.bb_upper),
    bbLower: asNullableNumber(r.bb_lower),
    bbPercentB: asNullableNumber(r.bb_percent_b),
    volumeRatio: asNullableNumber(r.volume_ratio),
  };

  const hasAnyNumericIndicator = Object.values(indicators).some((v) => v !== null);
  const rawSnapshot = safeJsonParse(r.raw_snapshot_json) as Record<string, any> | null;
  const rawOut =
    rawSnapshot?.outputSummary && typeof rawSnapshot.outputSummary === 'object'
      ? (rawSnapshot.outputSummary as Record<string, unknown>)
      : {};
  const isSkipped = r.status === 'SKIPPED';

  const indicatorFieldStates: Record<string, 'POPULATED' | 'ACTUAL_NULL' | 'UNAVAILABLE_IN_TELEMETRY'> = {};
  for (const [k, val] of Object.entries(indicators)) {
    if (val !== null) {
      indicatorFieldStates[k] = 'POPULATED';
    } else if (isSkipped || Object.prototype.hasOwnProperty.call(rawOut, k)) {
      indicatorFieldStates[k] = 'ACTUAL_NULL';
    } else {
      indicatorFieldStates[k] = 'UNAVAILABLE_IN_TELEMETRY';
    }
  }

  const regimeVal = r.regime ?? null;
  const trendDirVal = r.trend_direction ?? null;
  indicatorFieldStates.regime =
    regimeVal !== null
      ? 'POPULATED'
      : isSkipped || Object.prototype.hasOwnProperty.call(rawOut, 'regime')
        ? 'ACTUAL_NULL'
        : 'UNAVAILABLE_IN_TELEMETRY';
  indicatorFieldStates.trendDirection =
    trendDirVal !== null
      ? 'POPULATED'
      : isSkipped || Object.prototype.hasOwnProperty.call(rawOut, 'trendDirection')
        ? 'ACTUAL_NULL'
        : 'UNAVAILABLE_IN_TELEMETRY';

  const anyUnavailable = Object.values(indicatorFieldStates).some((s) => s === 'UNAVAILABLE_IN_TELEMETRY');
  const indicatorTelemetryStatus = isSkipped
    ? 'SKIPPED_NULL'
    : hasAnyNumericIndicator
      ? 'FULL'
      : anyUnavailable
        ? 'SUMMARY_ONLY_INDICATORS_NOT_EMITTED'
        : 'ACTUAL_NULL';

  return {
    snapshotId: r.snapshot_id,
    journey: r.journey,
    discoveryCycleId: r.discovery_cycle_id ?? null,
    cycleId: r.cycle_id ?? null,
    traceId: r.trace_id ?? null,
    userId: r.user_id ?? null,
    candleDatasetId: r.candle_dataset_id ?? null,
    symbol: r.symbol,
    timeframe: r.timeframe,
    status: r.status,
    skipReason: r.skip_reason ?? null,
    candlesCount: asNullableNumber(r.candles_count),
    minRequiredBars: asNullableNumber(r.min_required_bars),
    indicatorEngine: r.indicator_engine,
    ...indicators,
    regime: regimeVal,
    confidenceScore: asNullableNumber(r.confidence_score),
    trendDirection: trendDirVal,
    indicatorFieldStates,
    indicatorTelemetryStatus,
    telemetryLimitationNote:
      indicatorTelemetryStatus === 'SUMMARY_ONLY_INDICATORS_NOT_EMITTED'
        ? 'Producer (StrategyOrchestrator) emitted TA_COMPUTED summary metadata (engine, bars, confidenceScore) without individual indicator values; fields are unavailable in telemetry, not null indicator results.'
        : null,
    antiFabricationVerified: isSkipped ? !hasAnyNumericIndicator : true,
    rawSnapshot,
    computedAtMs: r.computed_at_ms,
  };
}

function mapStage2Row(r: any): Record<string, unknown> {
  return {
    decisionId: r.decision_id,
    journey: r.journey,
    discoveryCycleId: r.discovery_cycle_id ?? null,
    approvalGeneration: r.approval_generation ?? null,
    cycleId: r.cycle_id ?? null,
    traceId: r.trace_id ?? null,
    userId: r.user_id ?? null,
    environment: r.environment,
    symbol: r.symbol,
    eligible: Boolean(r.eligible),
    decisionOutcome: r.decision_outcome,
    rejectionReason: r.rejection_reason ?? null,
    allocatedBudgetUsdt: asNullableNumber(r.allocated_budget_usdt),
    accountBalanceUsdt: asNullableNumber(r.account_balance_usdt),
    lastPrice: asNullableNumber(r.last_price),
    minOrderQty: asNullableNumber(r.min_order_qty),
    minNotionalValue: asNullableNumber(r.min_notional_value),
    qtyStep: asNullableNumber(r.qty_step),
    computedQty: asNullableNumber(r.computed_qty),
    computedNotional: asNullableNumber(r.computed_notional),
    spreadPct: asNullableNumber(r.spread_pct),
    volume24h: asNullableNumber(r.volume_24h),
    discoveryScore: asNullableNumber(r.discovery_score),
    downstreamLeaked: Boolean(r.downstream_leaked),
    decidedAtMs: r.decided_at_ms,
    details: safeJsonParse(r.details_json),
  };
}

/**
 * Aggregates producer-reported delivery loss counters (shipped inside each delivered envelope).
 * NOTE: loss from batches that never reached the monitor is, by definition, not observable here.
 */
function summarizeProducerLoss(rows: any[]): {
  producers: number;
  httpIngestFailedEvents: number;
  overflowDroppedEvents: number;
  tier3ShedEvents: number;
  lastProducerError: string | null;
  unobservableLossNote: string;
} {
  let producers = 0;
  let httpIngestFailedEvents = 0;
  let overflowDroppedEvents = 0;
  let tier3ShedEvents = 0;
  let lastProducerError: string | null = null;
  for (const r of rows) {
    if (typeof r?.metric_key !== 'string' || !r.metric_key.startsWith('producer:')) continue;
    producers += 1;
    const ps = safeJsonParse(r.producer_stats_json) as any;
    if (!ps || typeof ps !== 'object') continue;
    httpIngestFailedEvents += Number(ps.httpFallbackFailed || 0) + Number(ps.queueSendFailed || 0);
    overflowDroppedEvents += Number(ps.overflowDropCount || 0);
    tier3ShedEvents += Number(ps.tier3ShedCount || 0);
    if (!lastProducerError && typeof ps.lastError === 'string' && ps.lastError) {
      lastProducerError = String(ps.lastError).slice(0, 160);
    }
  }
  return {
    producers,
    httpIngestFailedEvents,
    overflowDroppedEvents,
    tier3ShedEvents,
    lastProducerError,
    unobservableLossNote:
      'Best-effort delivery: batches lost to isolate eviction, waitUntil expiry or monitor downtime cannot be counted here.',
  };
}

async function handleOverview(url: URL, env: MonitoringEnv, scope: TenantScope): Promise<QueryResult> {
  const db = env.MONITORING_DB;
  const nowMs = Date.now();
  const windowMinutes = parseBoundInt(url.searchParams.get('windowMinutes'), 60, 5, 1440);
  const cutoffMs = nowMs - windowMinutes * 60_000;
  const environment = cleanParam(url.searchParams.get('environment'));
  const journey = cleanParam(url.searchParams.get('journey'));
  const symbol = cleanParam(url.searchParams.get('symbol'));
  const traceId = cleanParam(url.searchParams.get('traceId'));
  const cycleId = cleanParam(url.searchParams.get('cycleId'));
  const discoveryCycleId = cleanParam(url.searchParams.get('discoveryCycleId'));

  const spanFilterList: FilterItem[] = [
    { sql: 'emitted_at_ms >= ?', value: cutoffMs },
    { sql: 'environment = ?', value: environment },
    { sql: 'journey = ?', value: journey },
    { sql: 'symbol = ?', value: symbol },
    { sql: 'trace_id = ?', value: traceId },
    { sql: 'cycle_id = ?', value: cycleId },
    { sql: 'discovery_cycle_id = ?', value: discoveryCycleId },
    { sql: 'user_id = ?', value: scope.userId },
  ];
  addStage9DeviceFilter(spanFilterList, scope.deviceSessionHash);
  const spanFilters = buildWhereClause(spanFilterList);

  const cycleAWhere = buildWhereClause([
    { sql: `journey = 'JOURNEY_A_DISCOVERY'`, binds: [] },
    { sql: 'user_id = ?', value: scope.userId },
  ]);
  const cycleAWhereSql = cycleAWhere.params.length > 0
    ? `WHERE journey = 'JOURNEY_A_DISCOVERY' AND user_id = ?`
    : `WHERE journey = 'JOURNEY_A_DISCOVERY'`;
  const cycleBWhereSql = scope.userId
    ? `WHERE journey = 'JOURNEY_B_AUTONOMOUS' AND user_id = ?`
    : `WHERE journey = 'JOURNEY_B_AUTONOMOUS'`;

  const exchWhere = buildWhereClause([
    { sql: 'recorded_at_ms >= ?', value: cutoffMs },
    { sql: 'user_id = ?', value: scope.userId },
  ]);

  const incFilterList: FilterItem[] = [
    { sql: 'last_seen_at_ms >= ?', value: cutoffMs },
    { sql: 'user_id = ?', value: scope.userId },
    {
      sql: `NOT (stage = 2 AND UPPER(COALESCE(error_code, '')) = 'APPROVAL_EXPIRED_OR_INVALID')`,
      binds: [],
    },
    {
      sql: `NOT (stage = 6 AND UPPER(COALESCE(error_code, '')) IN ('REGIME_PROHIBITED', 'HTF_CONFLICT'))`,
      binds: [],
    },
  ];
  addStage9DeviceFilter(incFilterList, scope.deviceSessionHash);
  const incWhere = buildWhereClause(incFilterList);

  const staleApprovalSql = `(stage = 2 AND (UPPER(COALESCE(error_code, '')) = 'APPROVAL_EXPIRED_OR_INVALID' OR (event_type = 'DISCOVERY_HANDOFF_CONSUMED' AND (UPPER(COALESCE(error_code, '')) LIKE '%APPROVAL_EXPIRED%' OR UPPER(COALESCE(message, '')) LIKE '%APPROVAL_EXPIRED_OR_INVALID%'))))`;
  const expectedSafetyBlockSql = `(stage = 6 AND (UPPER(COALESCE(error_code, '')) IN ('REGIME_PROHIBITED', 'HTF_CONFLICT') OR (event_type = 'FINAL_DISPATCH_GATE' AND (UPPER(COALESCE(message, '')) LIKE '%REGIME_PROHIBITED%' OR UPPER(COALESCE(message, '')) LIKE '%HTF_CONFLICT%' OR UPPER(COALESCE(output_summary_json, '')) LIKE '%REGIME_PROHIBITED%' OR UPPER(COALESCE(output_summary_json, '')) LIKE '%HTF_CONFLICT%'))))`;

  const [
    rollupRes,
    latestByStageRes,
    latestJourneyARes,
    latestJourneyBRes,
    exchRes,
    latestExchByChannelRes,
    selfHealthRes,
    dlqRes,
    incCountRes,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT stage,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'PASS' OR ${expectedSafetyBlockSql} THEN 1 ELSE 0 END) AS pass_count,
                SUM(CASE WHEN status = 'WARN' THEN 1 ELSE 0 END) AS warn_count,
                SUM(CASE WHEN status = 'FAIL' AND NOT ${staleApprovalSql} AND NOT ${expectedSafetyBlockSql} THEN 1 ELSE 0 END) AS fail_count,
                SUM(CASE WHEN status = 'SKIPPED' OR ${staleApprovalSql} THEN 1 ELSE 0 END) AS skipped_count,
                SUM(CASE WHEN ${staleApprovalSql} THEN 1 ELSE 0 END) AS expired_approval_count,
                SUM(CASE WHEN ${expectedSafetyBlockSql} THEN 1 ELSE 0 END) AS expected_block_count,
                MAX(emitted_at_ms) AS latest_emitted_at_ms
         FROM stage_spans
         ${spanFilters.whereSql}
         GROUP BY stage`
      )
      .bind(...spanFilters.params)
      .all<any>(),
    db
      .prepare(
        `SELECT stage, span_id, status, severity, event_type, error_code, message,
                symbol, component, emitted_at_ms, trace_id, cycle_id, discovery_cycle_id,
                output_summary_json
         FROM (
           SELECT s.*, ROW_NUMBER() OVER (
             PARTITION BY s.stage
             ORDER BY s.emitted_at_ms DESC, s.stage_seq DESC
           ) AS rn
           FROM stage_spans s
           ${spanFilters.whereSql}
         )
         WHERE rn = 1`
      )
      .bind(...spanFilters.params)
      .all<any>(),
    db
      .prepare(
        `SELECT * FROM pipeline_cycles
         ${cycleAWhereSql}
         ORDER BY CASE WHEN discovery_cycle_id IS NOT NULL THEN 0 ELSE 1 END ASC, updated_at_ms DESC
         LIMIT 1`
      )
      .bind(...(scope.userId ? [scope.userId] : []))
      .first<any>(),
    db
      .prepare(
        `SELECT * FROM pipeline_cycles
         ${cycleBWhereSql}
         ORDER BY CASE WHEN cycle_id IS NOT NULL AND trace_id IS NOT NULL THEN 0 ELSE 1 END ASC, updated_at_ms DESC
         LIMIT 1`
      )
      .bind(...(scope.userId ? [scope.userId] : []))
      .first<any>(),
    db
      .prepare(
        `SELECT * FROM exchange_health_windows
         ${exchWhere.whereSql}
         ORDER BY recorded_at_ms DESC
         LIMIT 50`
      )
      .bind(...exchWhere.params)
      .all<any>(),
    db
      .prepare(
        `SELECT * FROM (
           SELECT e.*, ROW_NUMBER() OVER (
             PARTITION BY e.channel
             ORDER BY e.recorded_at_ms DESC
           ) AS rn
           FROM exchange_health_windows e
           ${exchWhere.whereSql}
         )
         WHERE rn = 1`
      )
      .bind(...exchWhere.params)
      .all<any>(),
    scope.isOperator && !scope.userId
      ? db.prepare(`SELECT * FROM monitoring_self_health ORDER BY updated_at_ms DESC LIMIT 10`).all<any>()
      : Promise.resolve({ results: [] }),
    scope.isOperator && !scope.userId
      ? db.prepare(`SELECT COUNT(*) AS count, MAX(received_at_ms) AS latest_ms FROM telemetry_dlq_records`).first<any>()
      : Promise.resolve({ count: 0, latest_ms: null }),
    db
      .prepare(`SELECT COUNT(*) AS count FROM data_quality_incidents ${incWhere.whereSql}`)
      .bind(...incWhere.params)
      .first<{ count: number }>(),
  ]);

  const rollupByStage = new Map<number, any>();
  for (const r of rollupRes.results || []) {
    rollupByStage.set(Number(r.stage), r);
  }

  const latestSpanByStage = new Map<number, any>();
  for (const s of latestByStageRes.results || []) {
    const st = Number(s.stage);
    if (!latestSpanByStage.has(st)) latestSpanByStage.set(st, s);
  }

  const stages = STAGE_CATALOG.map((def) => {
    const agg = rollupByStage.get(def.stage);
    const latest = latestSpanByStage.get(def.stage);
    const total = Number(agg?.total ?? 0);
    const passCount = Number(agg?.pass_count ?? 0);
    const warnCount = Number(agg?.warn_count ?? 0);
    const failCount = Number(agg?.fail_count ?? 0);
    const skippedCount = Number(agg?.skipped_count ?? 0);
    const expiredApprovalCount = Number(agg?.expired_approval_count ?? 0);
    const expectedBlockCount = Number(agg?.expected_block_count ?? 0);
    const latestEmittedAtMs = agg?.latest_emitted_at_ms ?? latest?.emitted_at_ms ?? null;
    const rawLatestStatus = latest?.status ?? null;
    const latestOut = safeJsonParse(latest?.output_summary_json) as Record<string, unknown> | null;

    const latestIsStaleApproval = latest
      ? isStaleApprovalExpiryEvent({
          stage: def.stage,
          eventType: latest.event_type,
          errorCode: latest.error_code,
          message: latest.message,
          outputSummary: latestOut,
        })
      : false;
    const latestIsExpectedBlock = latest
      ? isExpectedSafetyGateBlockEvent({
          stage: def.stage,
          eventType: latest.event_type,
          errorCode: latest.error_code,
          message: latest.message,
          outputSummary: latestOut,
        })
      : false;

    const effectiveLatestStatus = latestIsStaleApproval
      ? 'SKIPPED'
      : latestIsExpectedBlock
        ? 'PASS'
        : rawLatestStatus;

    let honestState = deriveHonestStageState({
      total,
      failCount,
      warnCount,
      passCount,
      latestStatus: effectiveLatestStatus,
      latestEmittedAtMs,
      nowMs,
      staleThresholdMs: def.staleThresholdMs,
    });
    if (def.stage === 2 && latestIsStaleApproval && failCount === 0) {
      honestState = 'STALE';
    }

    const latestClassification = latestIsStaleApproval
      ? 'APPROVAL_EXPIRED_STALE'
      : latestIsExpectedBlock
        ? 'EXPECTED_SAFETY_BLOCK'
        : null;

    return {
      stage: def.stage,
      name: def.name,
      shortName: def.shortName,
      honestState,
      totalSpans: total,
      passCount,
      warnCount,
      failCount,
      skippedCount,
      expiredApprovalCount,
      expectedBlockCount,
      latestEmittedAtMs,
      ageMs: latestEmittedAtMs ? Math.max(0, nowMs - latestEmittedAtMs) : null,
      latestStatus: rawLatestStatus,
      latestClassification,
      latestEventType: latest?.event_type ?? null,
      latestErrorCode: latest?.error_code ?? null,
      latestSymbol: latest?.symbol ?? null,
      latestComponent: latest?.component ?? null,
      latestMessage: latest?.message ?? 'No telemetry observed in selected window',
      latestTraceId: latest?.trace_id ?? null,
      latestCycleId: latest?.cycle_id ?? null,
      latestDiscoveryCycleId: latest?.discovery_cycle_id ?? null,
    };
  });

  // Separate public market data vs private authenticated account exchange channels
  // Use partitioned query first so ALARM_CYCLE ticks cannot push PUBLIC_MARKET_DATA out of LIMIT 50
  const latestExchangeByChannel = new Map<string, any>();
  for (const row of latestExchByChannelRes.results || []) {
    const ch = String(row.channel || 'UNKNOWN');
    if (!latestExchangeByChannel.has(ch)) latestExchangeByChannel.set(ch, row);
  }
  for (const row of exchRes.results || []) {
    const ch = String(row.channel || 'UNKNOWN');
    if (!latestExchangeByChannel.has(ch)) latestExchangeByChannel.set(ch, row);
  }

  const buildChannelHealth = (channels: string[], label: string) => {
    const hits = channels
      .map((ch) => latestExchangeByChannel.get(ch))
      .filter(Boolean)
      .sort((a, b) => Number(b.recorded_at_ms || 0) - Number(a.recorded_at_ms || 0));
    const hit = hits[0];
    if (!hit) {
      return {
        label,
        channelsChecked: channels,
        honestState: 'DISCONNECTED',
        status: 'DISCONNECTED',
        latencyMs: null,
        httpStatus: null,
        retCode: null,
        cacheTier: null,
        rateLimitRemaining: null,
        rateLimitLimit: null,
        tokensRemaining: null,
        staleCount: null,
        invalidCount: null,
        recordedAtMs: null,
        message: 'No exchange telemetry in selected window (never assumed connected)',
      };
    }
    const ageMs = Math.max(0, nowMs - Number(hit.recorded_at_ms || nowMs));
    const honestState =
      hit.status === 'FAIL'
        ? 'FAIL'
        : ageMs > 180_000
          ? 'STALE'
          : hit.status === 'WARN' || (hit.stale_count ?? 0) > 0 || (hit.invalid_count ?? 0) > 0
            ? 'DEGRADED'
            : 'CONNECTED';
    return {
      label,
      channel: hit.channel,
      endpoint: hit.endpoint ?? null,
      honestState,
      status: hit.status,
      latencyMs: asNullableNumber(hit.latency_ms),
      httpStatus: hit.http_status ?? null,
      retCode: hit.ret_code ?? null,
      cacheTier: hit.cache_tier ?? null,
      rateLimitRemaining: hit.rate_limit_remaining ?? null,
      rateLimitLimit: hit.rate_limit_limit ?? null,
      tokensRemaining: hit.tokens_remaining ?? null,
      instrumentsRequested: hit.instruments_requested ?? null,
      instrumentsReceived: hit.instruments_received ?? null,
      staleCount: hit.stale_count ?? 0,
      invalidCount: hit.invalid_count ?? 0,
      retryCount: hit.retry_count ?? 0,
      recordedAtMs: hit.recorded_at_ms,
      ageMs,
      errorCode: hit.error_code ?? null,
      message: hit.message ?? null,
    };
  };

  // Explicit Journey A -> Journey B Handoff Verification
  const parentGen = latestJourneyBRes?.parent_approval_generation ?? null;
  let matchingDiscovery: any = null;
  if (parentGen !== null && parentGen !== undefined) {
    const matchWhere = scope.userId
      ? `WHERE journey = 'JOURNEY_A_DISCOVERY' AND approval_generation = ? AND user_id = ?`
      : `WHERE journey = 'JOURNEY_A_DISCOVERY' AND approval_generation = ?`;
    matchingDiscovery = await db
      .prepare(
        `SELECT * FROM pipeline_cycles
         ${matchWhere}
         ORDER BY updated_at_ms DESC
         LIMIT 1`
      )
      .bind(...(scope.userId ? [parentGen, scope.userId] : [parentGen]))
      .first<any>();
  }

  let stage2Summary: any = null;
  if (latestJourneyARes?.discovery_cycle_id) {
    const s2SumWhere = scope.userId
      ? `WHERE discovery_cycle_id = ? AND user_id = ?`
      : `WHERE discovery_cycle_id = ?`;
    stage2Summary = await db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END) AS eligible_count,
                SUM(CASE WHEN eligible = 0 THEN 1 ELSE 0 END) AS rejected_count,
                SUM(CASE WHEN downstream_leaked = 1 THEN 1 ELSE 0 END) AS leaked_count
         FROM stage2_eligibility_decisions
         ${s2SumWhere}`
      )
      .bind(...(scope.userId ? [latestJourneyARes.discovery_cycle_id, scope.userId] : [latestJourneyARes.discovery_cycle_id]))
      .first<any>();
  }

  const consumerGlobal =
    (selfHealthRes.results || []).find((r: any) => r.metric_key === 'consumer_global') ||
    (selfHealthRes.results || [])[0] ||
    null;
  const dlqCount = Number(dlqRes?.count ?? 0);
  const d1WriteErrors = Number(consumerGlobal?.d1_write_errors ?? 0);

  let selfHealthStatus: 'NO_DATA' | 'HEALTHY' | 'DEGRADED' | 'FAIL' | 'SCOPED_REDACTED' =
    scope.isOperator && !scope.userId ? 'NO_DATA' : 'SCOPED_REDACTED';
  if (scope.isOperator && !scope.userId && consumerGlobal) {
    if (d1WriteErrors > 0) selfHealthStatus = 'FAIL';
    else if (dlqCount > 0 || Number(consumerGlobal.max_ingest_lag_ms || 0) > 15_000) selfHealthStatus = 'DEGRADED';
    else selfHealthStatus = 'HEALTHY';
  }

  const failedStages = stages.filter((s) => s.honestState === 'FAIL');
  const activeStages = stages.filter((s) => s.honestState !== 'DISCONNECTED');
  let overallVerdict: 'NO_TELEMETRY' | 'FAIL' | 'DEGRADED' | 'STALE' | 'HEALTHY' = 'NO_TELEMETRY';
  if (activeStages.length > 0) {
    if (failedStages.length > 0) overallVerdict = 'FAIL';
    else if (stages.some((s) => s.honestState === 'DEGRADED')) overallVerdict = 'DEGRADED';
    else if (stages.every((s) => s.honestState === 'STALE' || s.honestState === 'DISCONNECTED')) overallVerdict = 'STALE';
    else overallVerdict = 'HEALTHY';
  }

  return {
    status: 200,
    body: {
      ok: true,
      readOnly: true,
      generatedAtMs: nowMs,
      windowMinutes,
      filters: { environment, journey, symbol, traceId, cycleId, discoveryCycleId },
      overallVerdict,
      stages,
      exchangeHealth: {
        publicMarketData: buildChannelHealth(
          ['PUBLIC_MARKET_DATA', 'PUBLIC_REST', 'COORDINATOR', 'COORDINATOR_STATS'],
          'Public Market Data'
        ),
        privateAccount: buildChannelHealth(
          ['AUTHENTICATED_ACCOUNT', 'PRIVATE_ACCOUNT', 'EXCHANGE_PRIVATE', 'ORDER_DISPATCH', 'BYBIT_PRIVATE'],
          'Authenticated Account & Orders'
        ),
        recentWindowsCount: (exchRes.results || []).length,
      },
      journeys: {
        latestDiscovery: latestJourneyARes ? mapCycleRow(latestJourneyARes) : null,
        latestAutonomous: latestJourneyBRes ? mapCycleRow(latestJourneyBRes) : null,
        stage2Summary: stage2Summary
          ? {
              total: Number(stage2Summary.total ?? 0),
              eligibleCount: Number(stage2Summary.eligible_count ?? 0),
              rejectedCount: Number(stage2Summary.rejected_count ?? 0),
              leakedCount: Number(stage2Summary.leaked_count ?? 0),
            }
          : null,
        handoff: {
          parentApprovalGeneration: parentGen,
          latestDiscoveryApprovalGeneration: latestJourneyARes?.approval_generation ?? null,
          handoffLinked: Boolean(matchingDiscovery),
          linkedDiscoveryCycleId: matchingDiscovery?.discovery_cycle_id ?? null,
        },
      },
      selfHealth: {
        honestState: selfHealthStatus,
        eventsReceived: consumerGlobal?.events_received ?? 0,
        eventsInserted: consumerGlobal?.events_inserted ?? 0,
        eventsDeduped: consumerGlobal?.events_deduped ?? 0,
        dlqCount,
        d1WriteErrors,
        avgIngestLagMs: asNullableNumber(consumerGlobal?.avg_ingest_lag_ms),
        maxIngestLagMs: asNullableNumber(consumerGlobal?.max_ingest_lag_ms),
        lastD1CommittedAtMs: consumerGlobal?.last_d1_committed_at_ms ?? null,
        // Queue-free Cloudflare Free-plan architecture: best-effort delivery, never durable.
        deliveryMode: 'BEST_EFFORT_SERVICE_BINDING_WAITUNTIL',
        queueStatus: 'NOT_APPLICABLE',
        durableDelivery: false,
        producerReportedLoss:
          scope.isOperator && !scope.userId ? summarizeProducerLoss(selfHealthRes.results || []) : null,
      },
      recentIncidentsCount: Number(incCountRes?.count ?? 0),
    },
  };
}

async function handleTracesList(url: URL, env: MonitoringEnv, scope: TenantScope): Promise<QueryResult> {
  const db = env.MONITORING_DB;
  const limit = parseBoundInt(url.searchParams.get('limit'), 25, 1, 100);
  const offset = parseBoundInt(url.searchParams.get('offset'), 0, 0, 10_000);
  const journey = cleanParam(url.searchParams.get('journey'));
  const environment = cleanParam(url.searchParams.get('environment'));
  const status = cleanParam(url.searchParams.get('status'));
  const symbol = cleanParam(url.searchParams.get('symbol'));
  const discoveryCycleId = cleanParam(url.searchParams.get('discoveryCycleId'));
  const cycleId = cleanParam(url.searchParams.get('cycleId'));
  const traceId = cleanParam(url.searchParams.get('traceId'));
  const approvalGenerationRaw = url.searchParams.get('approvalGeneration');
  const approvalGeneration = approvalGenerationRaw ? parseBoundInt(approvalGenerationRaw, -1, 0, Number.MAX_SAFE_INTEGER) : null;

  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (scope.userId) { clauses.push('user_id = ?'); params.push(scope.userId); }
  if (journey) { clauses.push('journey = ?'); params.push(journey); }
  if (environment) { clauses.push('environment = ?'); params.push(environment); }
  if (status) { clauses.push('overall_status = ?'); params.push(status); }
  if (discoveryCycleId) { clauses.push('discovery_cycle_id = ?'); params.push(discoveryCycleId); }
  if (cycleId) { clauses.push('cycle_id = ?'); params.push(cycleId); }
  if (traceId) { clauses.push('trace_id = ?'); params.push(traceId); }
  if (approvalGeneration !== null && approvalGeneration >= 0) {
    clauses.push('(approval_generation = ? OR parent_approval_generation = ?)');
    params.push(approvalGeneration, approvalGeneration);
  }
  if (symbol) {
    const spanSubFilters: string[] = ['ss.symbol = ?'];
    params.push(symbol);
    if (scope.userId) {
      spanSubFilters.push('ss.user_id = ?');
      params.push(scope.userId);
    }
    if (scope.deviceSessionHash) {
      spanSubFilters.push('(ss.stage != 9 OR ss.android_device_session_hash = ?)');
      params.push(scope.deviceSessionHash);
    }
    clauses.push(
      `EXISTS (SELECT 1 FROM stage_spans ss WHERE ${spanSubFilters.join(' AND ')} AND (ss.trace_id = pipeline_cycles.trace_id OR ss.cycle_id = pipeline_cycles.cycle_id OR ss.discovery_cycle_id = pipeline_cycles.discovery_cycle_id))`
    );
  }
  if (scope.deviceSessionHash) {
    clauses.push(
      `(NOT EXISTS (SELECT 1 FROM stage_spans s9 WHERE s9.stage = 9 AND (s9.trace_id = pipeline_cycles.trace_id OR s9.cycle_id = pipeline_cycles.cycle_id)) OR EXISTS (SELECT 1 FROM stage_spans s9 WHERE s9.stage = 9 AND s9.android_device_session_hash = ? AND (s9.trace_id = pipeline_cycles.trace_id OR s9.cycle_id = pipeline_cycles.cycle_id)))`
    );
    params.push(scope.deviceSessionHash);
  }
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const [countRes, rowsRes] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM pipeline_cycles ${whereSql}`).bind(...params).first<{ total: number }>(),
    db
      .prepare(`SELECT * FROM pipeline_cycles ${whereSql} ORDER BY updated_at_ms DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all<any>(),
  ]);

  return {
    status: 200,
    body: {
      ok: true,
      readOnly: true,
      total: Number(countRes?.total ?? 0),
      limit,
      offset,
      items: (rowsRes.results || []).map(mapCycleRow),
    },
  };
}

async function handleTraceDetail(rawId: string, env: MonitoringEnv, scope: TenantScope): Promise<QueryResult> {
  const db = env.MONITORING_DB;
  const id = decodeURIComponent(rawId).trim();
  if (!id) return { status: 400, body: { error: 'Trace id is required' } };

  const cycleUserGuard = scope.userId ? ` AND user_id = ?` : '';
  const cycleBinds = scope.userId ? [id, id, id, id, scope.userId] : [id, id, id, id];
  const cycleRows = await db
    .prepare(
      `SELECT * FROM pipeline_cycles
       WHERE (trace_key = ? OR trace_id = ? OR cycle_id = ? OR discovery_cycle_id = ?)${cycleUserGuard}
       ORDER BY updated_at_ms DESC
       LIMIT 5`
    )
    .bind(...cycleBinds)
    .all<any>();

  const primaryCycle = (cycleRows.results || [])[0] || null;
  if (!scope.isOperator && !primaryCycle) {
    // Still allow direct stage_spans lookup ONLY when matching this user's own spans
    const spanProbeFilters: string[] = ['(trace_id = ? OR cycle_id = ? OR discovery_cycle_id = ?)', 'user_id = ?'];
    const spanProbeBinds: Array<string | number> = [id, id, id, scope.userId!];
    if (scope.deviceSessionHash) {
      spanProbeFilters.push('(stage != 9 OR android_device_session_hash = ?)');
      spanProbeBinds.push(scope.deviceSessionHash);
    }
    const ownedSpan = await db
      .prepare(`SELECT 1 AS found FROM stage_spans WHERE ${spanProbeFilters.join(' AND ')} LIMIT 1`)
      .bind(...spanProbeBinds)
      .first<any>();
    if (!ownedSpan) {
      return { status: 404, body: { error: `Trace '${id}' not found` } };
    }
  }

  const lookupIds = Array.from(
    new Set(
      [
        id,
        primaryCycle?.trace_id,
        primaryCycle?.cycle_id,
        primaryCycle?.discovery_cycle_id,
      ].filter((v): v is string => typeof v === 'string' && v.length > 0)
    )
  );

  const placeholders = lookupIds.map(() => '?').join(',');
  const spanClauses: string[] = [
    `(trace_id IN (${placeholders}) OR cycle_id IN (${placeholders}) OR discovery_cycle_id IN (${placeholders}))`,
  ];
  const spanBinds: Array<string | number> = [...lookupIds, ...lookupIds, ...lookupIds];
  if (scope.userId) {
    spanClauses.push('user_id = ?');
    spanBinds.push(scope.userId);
  }
  if (scope.deviceSessionHash) {
    spanClauses.push('(stage != 9 OR android_device_session_hash = ?)');
    spanBinds.push(scope.deviceSessionHash);
  }

  const spansRes = await db
    .prepare(
      `SELECT * FROM stage_spans
       WHERE ${spanClauses.join(' AND ')}
       ORDER BY stage ASC, stage_seq ASC, emitted_at_ms ASC
       LIMIT 250`
    )
    .bind(...spanBinds)
    .all<any>();

  const spans = (spansRes.results || []).map(mapSpanRow);
  if (!primaryCycle && spans.length === 0) {
    return { status: 404, body: { error: `Trace '${id}' not found` } };
  }

  const userSuffix = scope.userId ? ` AND user_id = ?` : '';
  const userBind = scope.userId ? [scope.userId] : [];
  const notifClauses: string[] = [`(trace_id IN (${placeholders}) OR cycle_id IN (${placeholders}))`];
  const notifBinds: Array<string | number> = [...lookupIds, ...lookupIds];
  if (scope.userId) {
    notifClauses.push('user_id = ?');
    notifBinds.push(scope.userId);
  }
  if (scope.deviceSessionHash) {
    if (scope.isOperator) {
      notifClauses.push('android_device_session_hash = ?');
    } else {
      notifClauses.push(
        `(android_device_session_hash = ? OR (android_device_session_hash IS NULL AND android_fcm_received_at_ms IS NULL AND android_poll_received_at_ms IS NULL AND android_rendered_at_ms IS NULL))`
      );
    }
    notifBinds.push(scope.deviceSessionHash);
  }

  const [s2Res, taRes, gatesRes, tradesRes, notifsRes] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM stage2_eligibility_decisions
         WHERE (trace_id IN (${placeholders}) OR cycle_id IN (${placeholders}) OR discovery_cycle_id IN (${placeholders}))${userSuffix}
         ORDER BY decided_at_ms ASC LIMIT 100`
      )
      .bind(...lookupIds, ...lookupIds, ...lookupIds, ...userBind)
      .all<any>(),
    db
      .prepare(
        `SELECT * FROM ta_indicator_snapshots
         WHERE (trace_id IN (${placeholders}) OR cycle_id IN (${placeholders}) OR discovery_cycle_id IN (${placeholders}))${userSuffix}
         ORDER BY computed_at_ms ASC LIMIT 100`
      )
      .bind(...lookupIds, ...lookupIds, ...lookupIds, ...userBind)
      .all<any>(),
    db
      .prepare(
        `SELECT * FROM gate_evaluations
         WHERE (trace_id IN (${placeholders}) OR cycle_id IN (${placeholders}) OR discovery_cycle_id IN (${placeholders}))${userSuffix}
         ORDER BY evaluated_at_ms ASC LIMIT 100`
      )
      .bind(...lookupIds, ...lookupIds, ...lookupIds, ...userBind)
      .all<any>(),
    db
      .prepare(
        `SELECT * FROM trade_lifecycle_ledger
         WHERE (trace_id IN (${placeholders}) OR cycle_id IN (${placeholders}))${userSuffix}
         ORDER BY updated_at_ms DESC LIMIT 50`
      )
      .bind(...lookupIds, ...lookupIds, ...userBind)
      .all<any>(),
    db
      .prepare(
        `SELECT * FROM notification_parity_ledger
         WHERE ${notifClauses.join(' AND ')}
         ORDER BY updated_at_ms DESC LIMIT 50`
      )
      .bind(...notifBinds)
      .all<any>(),
  ]);

  let upstreamDiscovery: Record<string, unknown> | null = null;
  let downstreamAutonomousCycles: Array<Record<string, unknown>> = [];

  if (primaryCycle?.parent_approval_generation != null) {
    const up = await db
      .prepare(
        `SELECT * FROM pipeline_cycles
         WHERE journey = 'JOURNEY_A_DISCOVERY' AND approval_generation = ?${userSuffix}
         ORDER BY updated_at_ms DESC LIMIT 1`
      )
      .bind(primaryCycle.parent_approval_generation, ...userBind)
      .first<any>();
    if (up) upstreamDiscovery = mapCycleRow(up);
  }
  if (primaryCycle?.journey === 'JOURNEY_A_DISCOVERY' && primaryCycle?.approval_generation != null) {
    const down = await db
      .prepare(
        `SELECT * FROM pipeline_cycles
         WHERE journey = 'JOURNEY_B_AUTONOMOUS' AND parent_approval_generation = ?${userSuffix}
         ORDER BY updated_at_ms DESC LIMIT 20`
      )
      .bind(primaryCycle.approval_generation, ...userBind)
      .all<any>();
    downstreamAutonomousCycles = (down.results || []).map(mapCycleRow);
  }

  return {
    status: 200,
    body: {
      ok: true,
      readOnly: true,
      cycle: primaryCycle ? mapCycleRow(primaryCycle) : null,
      relatedCycles: (cycleRows.results || []).slice(1).map(mapCycleRow),
      handoff: {
        upstreamDiscovery,
        downstreamAutonomousCycles,
      },
      spans,
      stage2Decisions: (s2Res.results || []).map(mapStage2Row),
      taSnapshots: (taRes.results || []).map(mapTaRow),
      gateEvaluations: (gatesRes.results || []).map(mapGateRow),
      trades: (tradesRes.results || []).map(mapTradeRow),
      notifications: (await normalizeAndSeparateNotificationRows(db, notifsRes.results || [])).map(mapNotificationRow),
    },
  };
}

function mapGateRow(g: any): Record<string, unknown> {
  const inputs = safeJsonParse(g.inputs_json) as Record<string, unknown> | null;
  const outputs = safeJsonParse(g.outputs_json) as Record<string, unknown> | null;
  const isExpectedBlock = isExpectedSafetyGateBlockEvent({
    stage: Number(g.stage),
    eventType: g.gate_name,
    errorCode: g.reason,
    message: g.reason,
    outputSummary: outputs,
  });
  const classification = isExpectedBlock
    ? 'EXPECTED_SAFETY_BLOCK'
    : g.decision === 'BLOCK'
      ? 'GATE_BLOCK'
      : g.decision === 'WARN' || g.decision === 'SHADOW_DIVERGED'
        ? 'GATE_WARN'
        : 'GATE_ALLOW';

  return {
    gateEvalId: g.gate_eval_id,
    stage: g.stage,
    journey: g.journey,
    cycleId: g.cycle_id ?? null,
    traceId: g.trace_id ?? null,
    discoveryCycleId: g.discovery_cycle_id ?? null,
    symbol: g.symbol ?? null,
    strategyId: g.strategy_id ?? null,
    timeframe: g.timeframe ?? null,
    gateName: g.gate_name,
    gateCategory: g.gate_category,
    decision: g.decision,
    gateDecision: g.decision,
    classification,
    isSystemError: !isExpectedBlock && g.decision === 'BLOCK' && Number(g.stage) !== 6,
    reason: g.reason ?? null,
    sourceFile: g.source_file ?? null,
    evaluatedAtMs: g.evaluated_at_ms,
    inputs,
    outputs,
  };
}

function computeParityMismatchesForQuery(
  bp: Record<string, any> | null,
  ap: Record<string, any> | null,
  backendEventType: string | null,
  androidRenderedAtMs: number | null,
  androidPostNotifyVerified: number | null,
  androidEligibilityOutcome: string | null,
  isFillRecord: boolean
): string[] {
  const mismatches: string[] = [];
  if (bp?.hasPlaceholderPnl3 === true) {
    mismatches.push('DEFECT_PLACEHOLDER_PNL_3');
  }
  if (bp?.hasTimeframe === false && String(backendEventType || '').toUpperCase().includes('FILL')) {
    mismatches.push('BACKEND_MISSING_TIMEFRAME');
  }
  if (bp && ap && !isFillRecord) {
    if (bp.symbol && ap.symbol && String(bp.symbol) !== String(ap.symbol)) {
      mismatches.push('FIELD_MISMATCH:symbol');
    }
    if (bp.strategyId && ap.strategyId && String(bp.strategyId) !== String(ap.strategyId)) {
      mismatches.push('FIELD_MISMATCH:strategyId');
    }
    if (bp.timeframe && ap.timeframe && String(bp.timeframe) !== String(ap.timeframe)) {
      mismatches.push('FIELD_MISMATCH:timeframe');
    }
    const bPrice = asNullableNumber(bp.entryPrice ?? bp.price);
    const aPrice = asNullableNumber(ap.entryPrice ?? ap.price);
    if (bPrice !== null && aPrice !== null && Math.abs(bPrice - aPrice) > 1e-6) {
      mismatches.push('FIELD_MISMATCH:entryPrice');
    }
    const bSl = asNullableNumber(bp.stopLossPrice ?? bp.stopLoss);
    const aSl = asNullableNumber(ap.stopLossPrice ?? ap.stopLoss);
    if (bSl !== null && aSl !== null && Math.abs(bSl - aSl) > 1e-6) {
      mismatches.push('FIELD_MISMATCH:stopLossPrice');
    }
    const bTp = asNullableNumber(bp.takeProfitPrice ?? bp.takeProfit);
    const aTp = asNullableNumber(ap.takeProfitPrice ?? ap.takeProfit);
    if (bTp !== null && aTp !== null && Math.abs(bTp - aTp) > 1e-6) {
      mismatches.push('FIELD_MISMATCH:takeProfitPrice');
    }
    if (typeof bp.isExecutable === 'boolean' && typeof ap.isExecutable === 'boolean' && bp.isExecutable !== ap.isExecutable) {
      mismatches.push('FIELD_MISMATCH:isExecutable');
    }
  }
  if (ap?.rendered === false && !androidRenderedAtMs) {
    mismatches.push('ANDROID_POPUP_RENDER_FAILED');
  }
  if (
    androidPostNotifyVerified === 0 &&
    !androidRenderedAtMs &&
    androidEligibilityOutcome !== 'SUPPRESSED_PRECHECK'
  ) {
    mismatches.push('ANDROID_POST_CHECK_MISSING');
  }
  return Array.from(new Set(mismatches));
}

async function normalizeAndSeparateNotificationRows(
  db: D1Database,
  rawRows: any[]
): Promise<any[]> {
  // Exclude orphan secondary popup renders that had null alert_id and null fcm_message_id and no backend event
  const nonOrphanRows = rawRows.filter((r) => {
    const isOrphanNullAlert =
      !r.alert_id &&
      !r.fcm_message_id &&
      !r.backend_dispatched_at_ms &&
      !r.backend_event_type;
    return !isOrphanNullAlert;
  });

  // Identify any historical rows where TRADE_FILLED overwrote TRADE_ALERT on the same row
  const existingKeys = new Set(nonOrphanRows.map((r) => String(r.correlation_key)));
  const collidedAlertIds = Array.from(
    new Set(
      nonOrphanRows
        .filter(
          (r) =>
            r.alert_id &&
            String(r.backend_event_type || '').toUpperCase() === 'TRADE_FILLED' &&
            r.android_rendered_at_ms !== null &&
            !String(r.correlation_key || '').endsWith(':TRADE_FILLED') &&
            !existingKeys.has(`${r.correlation_key}:TRADE_FILLED`)
        )
        .map((r) => String(r.alert_id))
    )
  );

  const stage8ByAlert = new Map<string, any[]>();
  if (collidedAlertIds.length > 0) {
    const ph = collidedAlertIds.map(() => '?').join(',');
    const s8Res = await db
      .prepare(
        `SELECT * FROM stage_spans
         WHERE stage = 8 AND alert_id IN (${ph})
         ORDER BY emitted_at_ms ASC`
      )
      .bind(...collidedAlertIds)
      .all<any>();
    for (const sp of s8Res.results || []) {
      const aid = String(sp.alert_id || '');
      if (!stage8ByAlert.has(aid)) stage8ByAlert.set(aid, []);
      stage8ByAlert.get(aid)!.push(sp);
    }
  }

  const expanded: any[] = [];
  for (const r of nonOrphanRows) {
    const aid = r.alert_id ? String(r.alert_id) : '';
    const spans = aid ? stage8ByAlert.get(aid) : undefined;
    if (spans && spans.length > 0) {
      const alertSpan = spans.find((s) => {
        const out = safeJsonParse(s.output_summary_json) as Record<string, any> | null;
        const nt = String(out?.notificationType || '').toUpperCase();
        return nt === 'TRADE_ALERT' || (!nt.includes('FILL') && !String(s.event_type || '').toUpperCase().includes('FILL'));
      });
      const fillSpan = spans.find((s) => {
        const out = safeJsonParse(s.output_summary_json) as Record<string, any> | null;
        const nt = String(out?.notificationType || '').toUpperCase();
        return nt.includes('FILL') || String(s.event_type || '').toUpperCase().includes('FILL');
      });

      if (alertSpan && fillSpan) {
        const alertOut = (safeJsonParse(alertSpan.output_summary_json) as Record<string, any> | null) || {};
        const fillOut = (safeJsonParse(fillSpan.output_summary_json) as Record<string, any> | null) || {};
        const ap = (safeJsonParse(r.android_rendered_fields_json) as Record<string, any> | null) || null;
        const alertBp: Record<string, any> = {
          ...alertOut,
          symbol: alertSpan.symbol ?? alertOut.symbol ?? r.symbol,
          strategyId: alertSpan.strategy_id ?? alertOut.strategyId ?? r.strategy_id,
          timeframe: alertSpan.timeframe ?? alertOut.timeframe ?? r.timeframe,
        };
        const alertMismatches = computeParityMismatchesForQuery(
          alertBp,
          ap,
          'TRADE_ALERT',
          asNullableNumber(r.android_rendered_at_ms),
          asNullableNumber(r.android_post_notify_verified),
          r.android_eligibility_outcome ?? null,
          false
        );
        const androidConfirmed = Boolean(r.android_rendered_at_ms || r.android_post_notify_verified === 1);
        const alertParityStatus =
          alertMismatches.length > 0
            ? PARITY_STATUSES.PARITY_MISMATCH
            : androidConfirmed
              ? PARITY_STATUSES.PARITY_OK
              : PARITY_STATUSES.PENDING_ANDROID;

        expanded.push({
          ...r,
          timeframe: alertSpan.timeframe ?? alertOut.timeframe ?? r.timeframe,
          backend_event_type: 'TRADE_ALERT',
          backend_dispatched_at_ms: alertSpan.emitted_at_ms ?? r.backend_dispatched_at_ms,
          fcm_http_status: alertOut.fcmHttpStatus ?? r.fcm_http_status,
          fcm_dispatch_status: alertOut.fcmDispatchStatus || (alertSpan.status === 'FAIL' ? 'FAILED' : 'SENT'),
          backend_payload_json: JSON.stringify(alertBp),
          parity_status: alertParityStatus,
          parity_mismatches_json: JSON.stringify(alertMismatches),
        });

        const fillBp: Record<string, any> = {
          ...fillOut,
          fillPrice: fillOut.avgFillPrice ?? fillOut.price,
          symbol: fillSpan.symbol ?? fillOut.symbol ?? r.symbol,
          strategyId: fillSpan.strategy_id ?? fillOut.strategyId ?? r.strategy_id,
          timeframe: fillSpan.timeframe ?? fillOut.timeframe ?? null,
        };
        const fillMismatches = computeParityMismatchesForQuery(
          fillBp,
          null,
          'TRADE_FILLED',
          null,
          null,
          null,
          true
        );
        const fillDispatchStatus = fillOut.fcmDispatchStatus || (fillSpan.status === 'FAIL' ? 'FAILED' : 'SENT');
        const fillParityStatus =
          fillDispatchStatus === 'FAILED'
            ? PARITY_STATUSES.FCM_FAILED
            : fillMismatches.length > 0
              ? PARITY_STATUSES.PARITY_MISMATCH
              : PARITY_STATUSES.PENDING_ANDROID;

        expanded.push({
          ...r,
          correlation_key: `${r.correlation_key}:TRADE_FILLED`,
          timeframe: fillSpan.timeframe ?? fillOut.timeframe ?? null,
          backend_event_type: 'TRADE_FILLED',
          backend_dispatched_at_ms: fillSpan.emitted_at_ms ?? r.backend_dispatched_at_ms,
          fcm_http_status: fillOut.fcmHttpStatus ?? r.fcm_http_status,
          fcm_dispatch_status: fillDispatchStatus,
          backend_payload_json: JSON.stringify(fillBp),
          android_fcm_received_at_ms: null,
          android_poll_received_at_ms: null,
          android_source: null,
          android_dedup_outcome: null,
          android_eligibility_outcome: null,
          android_eligibility_reason: null,
          android_post_notify_verified: null,
          android_os_heads_up_state: 'UNKNOWN',
          android_validated_at_ms: null,
          android_validation_outcome: null,
          android_validation_reason: null,
          android_rendered_at_ms: null,
          android_rendered_fields_json: null,
          parity_status: fillParityStatus,
          parity_mismatches_json: JSON.stringify(fillMismatches),
        });
        continue;
      }
    }
    expanded.push(r);
  }
  return expanded;
}

async function handleTaAndStage2(url: URL, env: MonitoringEnv, scope: TenantScope): Promise<QueryResult> {
  const db = env.MONITORING_DB;
  const limit = parseBoundInt(url.searchParams.get('limit'), 50, 1, 100);
  const offset = parseBoundInt(url.searchParams.get('offset'), 0, 0, 10_000);
  const symbol = cleanParam(url.searchParams.get('symbol'));
  const timeframe = cleanParam(url.searchParams.get('timeframe'));
  const journey = cleanParam(url.searchParams.get('journey'));
  const indicatorEngine = cleanParam(url.searchParams.get('indicatorEngine'));
  const status = cleanParam(url.searchParams.get('status'));
  const traceId = cleanParam(url.searchParams.get('traceId'));
  const cycleId = cleanParam(url.searchParams.get('cycleId'));
  const discoveryCycleId = cleanParam(url.searchParams.get('discoveryCycleId'));

  const taWhere = buildWhereClause([
    { sql: 'user_id = ?', value: scope.userId },
    { sql: 'symbol = ?', value: symbol },
    { sql: 'timeframe = ?', value: timeframe },
    { sql: 'journey = ?', value: journey },
    { sql: 'indicator_engine = ?', value: indicatorEngine },
    { sql: 'status = ?', value: status },
    { sql: 'trace_id = ?', value: traceId },
    { sql: 'cycle_id = ?', value: cycleId },
    { sql: 'discovery_cycle_id = ?', value: discoveryCycleId },
  ]);

  const s2Where = buildWhereClause([
    { sql: 'user_id = ?', value: scope.userId },
    { sql: 'symbol = ?', value: symbol },
    { sql: 'journey = ?', value: journey },
    { sql: 'trace_id = ?', value: traceId },
    { sql: 'cycle_id = ?', value: cycleId },
    { sql: 'discovery_cycle_id = ?', value: discoveryCycleId },
  ]);

  const leakedClauses: string[] = ['d.eligible = 0'];
  const leakedParams: Array<string | number> = [];
  if (scope.userId) { leakedClauses.push('d.user_id = ?'); leakedParams.push(scope.userId); }
  if (symbol) { leakedClauses.push('d.symbol = ?'); leakedParams.push(symbol); }
  if (journey) { leakedClauses.push('d.journey = ?'); leakedParams.push(journey); }
  if (traceId) { leakedClauses.push('d.trace_id = ?'); leakedParams.push(traceId); }
  if (cycleId) { leakedClauses.push('d.cycle_id = ?'); leakedParams.push(cycleId); }
  if (discoveryCycleId) { leakedClauses.push('d.discovery_cycle_id = ?'); leakedParams.push(discoveryCycleId); }

  const taSubUserClause = scope.userId ? ' AND t.user_id = ?' : '';
  const taSubUserParam = scope.userId ? [scope.userId] : [];

  const [taCountRes, taRowsRes, s2RowsRes, s2SummaryRes, leakedRes] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM ta_indicator_snapshots ${taWhere.whereSql}`).bind(...taWhere.params).first<{ total: number }>(),
    db
      .prepare(`SELECT * FROM ta_indicator_snapshots ${taWhere.whereSql} ORDER BY computed_at_ms DESC LIMIT ? OFFSET ?`)
      .bind(...taWhere.params, limit, offset)
      .all<any>(),
    db
      .prepare(`SELECT * FROM stage2_eligibility_decisions ${s2Where.whereSql} ORDER BY decided_at_ms DESC LIMIT ?`)
      .bind(...s2Where.params, limit)
      .all<any>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END) AS eligible_count,
                SUM(CASE WHEN eligible = 0 THEN 1 ELSE 0 END) AS rejected_count,
                SUM(CASE WHEN downstream_leaked = 1 THEN 1 ELSE 0 END) AS leaked_count
         FROM stage2_eligibility_decisions ${s2Where.whereSql}`
      )
      .bind(...s2Where.params)
      .first<any>(),
    db
      .prepare(
        `SELECT d.symbol, d.decision_outcome, d.rejection_reason, d.discovery_cycle_id, d.decided_at_ms
         FROM stage2_eligibility_decisions d
         WHERE ${leakedClauses.join(' AND ')} AND (
           d.downstream_leaked = 1 OR EXISTS (
             SELECT 1 FROM ta_indicator_snapshots t
             WHERE t.symbol = d.symbol AND d.discovery_cycle_id IS NOT NULL AND t.discovery_cycle_id = d.discovery_cycle_id${taSubUserClause}
           )
         )
         ORDER BY d.decided_at_ms DESC
         LIMIT 25`
      )
      .bind(...leakedParams, ...taSubUserParam)
      .all<any>(),
  ]);

  const items = (taRowsRes.results || []).map(mapTaRow);
  const leakedRows = leakedRes.results || [];

  return {
    status: 200,
    body: {
      ok: true,
      readOnly: true,
      total: Number(taCountRes?.total ?? 0),
      limit,
      offset,
      items,
      stage2Decisions: (s2RowsRes.results || []).map(mapStage2Row),
      stage2LeakCheck: {
        totalDecisions: Number(s2SummaryRes?.total ?? 0),
        eligibleCount: Number(s2SummaryRes?.eligible_count ?? 0),
        rejectedCount: Number(s2SummaryRes?.rejected_count ?? 0),
        downstreamLeakedCount: Math.max(Number(s2SummaryRes?.leaked_count ?? 0), leakedRows.length),
        leakedSamples: leakedRows,
      },
    },
  };
}

async function handleStrategiesAndGates(url: URL, env: MonitoringEnv, scope: TenantScope): Promise<QueryResult> {
  const db = env.MONITORING_DB;
  const limit = parseBoundInt(url.searchParams.get('limit'), 50, 1, 100);
  const offset = parseBoundInt(url.searchParams.get('offset'), 0, 0, 10_000);
  const symbol = cleanParam(url.searchParams.get('symbol'));
  const strategyId = cleanParam(url.searchParams.get('strategyId'));
  const decision = cleanParam(url.searchParams.get('decision'));
  const gateCategory = cleanParam(url.searchParams.get('gateCategory'));
  const traceId = cleanParam(url.searchParams.get('traceId'));
  const cycleId = cleanParam(url.searchParams.get('cycleId'));
  const stageRaw = url.searchParams.get('stage');
  const stageFilter = stageRaw ? parseBoundInt(stageRaw, -1, 1, 9) : null;

  const gateWhere = buildWhereClause([
    { sql: 'user_id = ?', value: scope.userId },
    { sql: 'symbol = ?', value: symbol },
    { sql: 'strategy_id = ?', value: strategyId },
    { sql: 'decision = ?', value: decision },
    { sql: 'gate_category = ?', value: gateCategory },
    { sql: 'trace_id = ?', value: traceId },
    { sql: 'cycle_id = ?', value: cycleId },
    { sql: 'stage = ?', value: stageFilter !== null && stageFilter > 0 ? stageFilter : null },
  ]);

  const spanWhere = buildWhereClause([
    { sql: 'stage IN (5, 6)', binds: [] },
    { sql: 'user_id = ?', value: scope.userId },
    { sql: 'symbol = ?', value: symbol },
    { sql: 'strategy_id = ?', value: strategyId },
    { sql: 'trace_id = ?', value: traceId },
    { sql: 'cycle_id = ?', value: cycleId },
  ]);
  const spanSqlWhere = spanWhere.whereSql
    ? `WHERE stage IN (5, 6) AND ${spanWhere.whereSql.slice(6)}`
    : `WHERE stage IN (5, 6)`;

  const shadowWhere = buildWhereClause([
    { sql: 'user_id = ?', value: scope.userId },
    { sql: 'symbol = ?', value: symbol },
    { sql: 'strategy_id = ?', value: strategyId },
    { sql: 'trace_id = ?', value: traceId },
    { sql: 'cycle_id = ?', value: cycleId },
  ]);
  const shadowSqlWhere = shadowWhere.whereSql
    ? `WHERE event_type IN ('SIGNAL_SHADOW_DIFF', 'SIGNAL_LIFECYCLE_EVAL') AND ${shadowWhere.whereSql.slice(6)}`
    : `WHERE event_type IN ('SIGNAL_SHADOW_DIFF', 'SIGNAL_LIFECYCLE_EVAL')`;

  const [countRes, gatesRes, spansRes, shadowSpansRes] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM gate_evaluations ${gateWhere.whereSql}`).bind(...gateWhere.params).first<{ total: number }>(),
    db
      .prepare(`SELECT * FROM gate_evaluations ${gateWhere.whereSql} ORDER BY evaluated_at_ms DESC LIMIT ? OFFSET ?`)
      .bind(...gateWhere.params, limit, offset)
      .all<any>(),
    db
      .prepare(`SELECT * FROM stage_spans ${spanSqlWhere} ORDER BY emitted_at_ms DESC LIMIT 50`)
      .bind(...spanWhere.params)
      .all<any>(),
    db
      .prepare(
        `SELECT * FROM stage_spans
         ${shadowSqlWhere}
         ORDER BY emitted_at_ms DESC
         LIMIT 25`
      )
      .bind(...shadowWhere.params)
      .all<any>(),
  ]);

  return {
    status: 200,
    body: {
      ok: true,
      readOnly: true,
      total: Number(countRes?.total ?? 0),
      limit,
      offset,
      gateEvaluations: (gatesRes.results || []).map(mapGateRow),
      strategySpans: (spansRes.results || []).filter((s: any) => Number(s.stage) === 5).map(mapSpanRow),
      safetyGateSpans: (spansRes.results || []).filter((s: any) => Number(s.stage) === 6).map(mapSpanRow),
      shadowModeComparisons: (shadowSpansRes.results || []).map(mapSpanRow),
      deadUnwiredComponents: DEAD_UNWIRED_COMPONENTS,
    },
  };
}

async function handleTradesList(url: URL, env: MonitoringEnv, scope: TenantScope): Promise<QueryResult> {
  const db = env.MONITORING_DB;
  const limit = parseBoundInt(url.searchParams.get('limit'), 50, 1, 100);
  const offset = parseBoundInt(url.searchParams.get('offset'), 0, 0, 10_000);
  const symbol = cleanParam(url.searchParams.get('symbol'));
  const executionStatus = cleanParam(url.searchParams.get('executionStatus') || url.searchParams.get('status'));
  const milestone = cleanParam(url.searchParams.get('milestone'));
  const alertId = cleanParam(url.searchParams.get('alertId'));
  const orderId = cleanParam(url.searchParams.get('orderId'));
  const traceId = cleanParam(url.searchParams.get('traceId'));
  const cycleId = cleanParam(url.searchParams.get('cycleId'));

  const where = buildWhereClause([
    { sql: 'user_id = ?', value: scope.userId },
    { sql: 'symbol = ?', value: symbol },
    { sql: 'alert_id = ?', value: alertId },
    { sql: 'order_id = ?', value: orderId },
    { sql: 'trace_id = ?', value: traceId },
    { sql: 'cycle_id = ?', value: cycleId },
  ]);

  const rowsRes = await db
    .prepare(`SELECT * FROM trade_lifecycle_ledger ${where.whereSql} ORDER BY updated_at_ms DESC LIMIT 200`)
    .bind(...where.params)
    .all<any>();

  const mappedAll = (rowsRes.results || [])
    .map(mapTradeRow)
    .filter((t) => {
      if (executionStatus && String(t.executionStatus) !== executionStatus) return false;
      if (milestone && String(t.currentMilestone) !== milestone) return false;
      return true;
    });

  const paged = mappedAll.slice(offset, offset + limit);

  return {
    status: 200,
    body: {
      ok: true,
      readOnly: true,
      total: mappedAll.length,
      limit,
      offset,
      items: paged,
    },
  };
}

async function handleTradeDetail(rawId: string, env: MonitoringEnv, scope: TenantScope): Promise<QueryResult> {
  const db = env.MONITORING_DB;
  const id = decodeURIComponent(rawId).trim();
  if (!id) return { status: 400, body: { error: 'Trade id is required' } };

  const tradeUserGuard = scope.userId ? ` AND user_id = ?` : '';
  const tradeBinds = scope.userId ? [id, id, id, id, id, scope.userId] : [id, id, id, id, id];
  const trade = await db
    .prepare(
      `SELECT * FROM trade_lifecycle_ledger
       WHERE (trade_key = ? OR alert_id = ? OR intent_id = ? OR client_order_id = ? OR order_id = ?)${tradeUserGuard}
       ORDER BY updated_at_ms DESC
       LIMIT 1`
    )
    .bind(...tradeBinds)
    .first<any>();

  if (!trade) {
    return { status: 404, body: { error: `Trade '${id}' not found` } };
  }

  const keys = Array.from(
    new Set(
      [trade.alert_id, trade.intent_id, trade.client_order_id, trade.order_id, trade.trace_id].filter(
        (v): v is string => typeof v === 'string' && v.length > 0
      )
    )
  );

  let correlatedSpans: Array<Record<string, unknown>> = [];
  let correlatedNotifications: Array<Record<string, unknown>> = [];

  if (keys.length > 0) {
    const ph = keys.map(() => '?').join(',');
    const spanClauses: string[] = [
      `(alert_id IN (${ph}) OR intent_id IN (${ph}) OR client_order_id IN (${ph}) OR order_id IN (${ph}) OR trace_id IN (${ph}))`,
    ];
    const spanBinds: Array<string | number> = [...keys, ...keys, ...keys, ...keys, ...keys];
    if (scope.userId) {
      spanClauses.push('user_id = ?');
      spanBinds.push(scope.userId);
    }
    if (scope.deviceSessionHash) {
      spanClauses.push('(stage != 9 OR android_device_session_hash = ?)');
      spanBinds.push(scope.deviceSessionHash);
    }

    const notifFilters: FilterItem[] = [];
    if (trade.alert_id) notifFilters.push({ sql: 'alert_id = ?', binds: [trade.alert_id] });
    else if (trade.trace_id) notifFilters.push({ sql: 'trace_id = ?', binds: [trade.trace_id] });
    if (notifFilters.length > 0) {
      if (scope.userId) notifFilters.push({ sql: 'user_id = ?', binds: [scope.userId] });
      addNotificationDeviceFilter(notifFilters, scope);
    }
    const notifWhere = notifFilters.length > 0 ? buildWhereClause(notifFilters) : null;

    const [spRes, ntRes] = await Promise.all([
      db
        .prepare(
          `SELECT * FROM stage_spans
           WHERE ${spanClauses.join(' AND ')}
           ORDER BY stage ASC, stage_seq ASC, emitted_at_ms ASC
           LIMIT 100`
        )
        .bind(...spanBinds)
        .all<any>(),
      notifWhere
        ? db
            .prepare(`SELECT * FROM notification_parity_ledger ${notifWhere.whereSql} ORDER BY updated_at_ms DESC LIMIT 25`)
            .bind(...notifWhere.params)
            .all<any>()
        : Promise.resolve({ results: [] }),
    ]);
    correlatedSpans = (spRes.results || []).map(mapSpanRow);
    const normalizedNotifRows = await normalizeAndSeparateNotificationRows(db, ntRes.results || []);
    correlatedNotifications = normalizedNotifRows.map(mapNotificationRow);
  }

  return {
    status: 200,
    body: {
      ok: true,
      readOnly: true,
      trade: mapTradeRow(trade),
      spans: correlatedSpans,
      notifications: correlatedNotifications,
    },
  };
}

async function handleNotifications(url: URL, env: MonitoringEnv, scope: TenantScope): Promise<QueryResult> {
  const db = env.MONITORING_DB;
  const limit = parseBoundInt(url.searchParams.get('limit'), 50, 1, 100);
  const offset = parseBoundInt(url.searchParams.get('offset'), 0, 0, 10_000);
  const parityStatus = cleanParam(url.searchParams.get('parityStatus'));
  const symbol = cleanParam(url.searchParams.get('symbol'));
  const alertId = cleanParam(url.searchParams.get('alertId'));
  const fcmMessageId = cleanParam(url.searchParams.get('fcmMessageId'));
  const osState = cleanParam(url.searchParams.get('androidOsHeadsUpState'));
  const traceId = cleanParam(url.searchParams.get('traceId'));

  const baseFilters: FilterItem[] = [
    { sql: 'user_id = ?', value: scope.userId },
  ];
  addNotificationDeviceFilter(baseFilters, scope);
  const baseWhere = buildWhereClause(baseFilters);

  const allRowsRes = await db
    .prepare(`SELECT * FROM notification_parity_ledger ${baseWhere.whereSql} ORDER BY updated_at_ms DESC LIMIT 250`)
    .bind(...baseWhere.params)
    .all<any>();

  const normalizedRows = await normalizeAndSeparateNotificationRows(db, allRowsRes.results || []);
  const mappedAll = normalizedRows.map(mapNotificationRow);

  let parityOkCount = 0;
  let parityMismatchCount = 0;
  let pendingAndroidCount = 0;
  let pendingBackendCount = 0;
  let droppedOnAndroidCount = 0;
  let fcmFailedCount = 0;
  let fcmDispatchFailedCount = 0;
  let pollFallbackDeliveredCount = 0;
  let eligibleOsUnprovableCount = 0;
  let postCheckMissingCount = 0;
  let suppressedPrecheckCount = 0;

  for (const item of mappedAll) {
    const ps = String(item.parityStatus || '');
    if (ps === PARITY_STATUSES.PARITY_OK) parityOkCount += 1;
    else if (ps === PARITY_STATUSES.PARITY_MISMATCH) parityMismatchCount += 1;
    else if (ps === PARITY_STATUSES.PENDING_ANDROID) pendingAndroidCount += 1;
    else if (ps === PARITY_STATUSES.PENDING_BACKEND) pendingBackendCount += 1;
    else if (ps === PARITY_STATUSES.DROPPED_ON_ANDROID) droppedOnAndroidCount += 1;
    else if (ps === PARITY_STATUSES.FCM_FAILED) fcmFailedCount += 1;

    if (item.fcmDispatchStatus === 'FAILED') fcmDispatchFailedCount += 1;
    if (item.androidDeliveryStatus === 'DELIVERED_VIA_POLL_FALLBACK' || item.androidDeliveryStatus === 'DELIVERED_FCM_AND_POLL') {
      pollFallbackDeliveredCount += 1;
    }

    const os = String(item.androidOsHeadsUpState || '');
    if (os === 'ELIGIBLE_OS_UNPROVABLE') eligibleOsUnprovableCount += 1;
    else if (os === 'POST_CHECK_MISSING') postCheckMissingCount += 1;
    else if (os === 'SUPPRESSED_PRECHECK') suppressedPrecheckCount += 1;
  }

  const filteredItems = mappedAll.filter((item) => {
    if (parityStatus && String(item.parityStatus) !== parityStatus) return false;
    if (symbol && String(item.symbol || '') !== symbol) return false;
    if (alertId && String(item.alertId || '') !== alertId) return false;
    if (fcmMessageId && String(item.fcmMessageId || '') !== fcmMessageId) return false;
    if (osState && String(item.androidOsHeadsUpState || '') !== osState) return false;
    if (traceId && String(item.traceId || '') !== traceId) return false;
    return true;
  });

  const pagedItems = filteredItems.slice(offset, offset + limit);

  return {
    status: 200,
    body: {
      ok: true,
      readOnly: true,
      total: filteredItems.length,
      limit,
      offset,
      summary: {
        total: mappedAll.length,
        parityOkCount,
        parityMismatchCount,
        matchedCount: parityOkCount,
        mismatchCount: parityMismatchCount,
        pendingAndroidCount,
        pendingBackendCount,
        droppedOnAndroidCount,
        fcmFailedCount,
        fcmDispatchFailedCount,
        pollFallbackDeliveredCount,
        eligibleOsUnprovableCount,
        postCheckMissingCount,
        suppressedPrecheckCount,
      },
      items: pagedItems,
    },
  };
}

async function handleIncidentsList(url: URL, env: MonitoringEnv, scope: TenantScope): Promise<QueryResult> {
  const db = env.MONITORING_DB;
  const limit = parseBoundInt(url.searchParams.get('limit'), 50, 1, 100);
  const offset = parseBoundInt(url.searchParams.get('offset'), 0, 0, 10_000);
  const stageRaw = url.searchParams.get('stage');
  const stage = stageRaw ? parseBoundInt(stageRaw, -1, 1, 9) : null;
  const severity = cleanParam(url.searchParams.get('severity'));
  const symbol = cleanParam(url.searchParams.get('symbol'));
  const strategyId = cleanParam(url.searchParams.get('strategyId'));
  const errorCode = cleanParam(url.searchParams.get('errorCode'));

  const filters: FilterItem[] = [
    { sql: 'user_id = ?', value: scope.userId },
    { sql: 'stage = ?', value: stage !== null && stage > 0 ? stage : null },
    { sql: 'severity = ?', value: severity },
    { sql: 'symbol = ?', value: symbol },
    { sql: 'strategy_id = ?', value: strategyId },
    { sql: 'error_code = ?', value: errorCode },
  ];
  if (!errorCode) {
    filters.push({
      sql: `NOT (stage = 2 AND UPPER(COALESCE(error_code, '')) = 'APPROVAL_EXPIRED_OR_INVALID')`,
      binds: [],
    });
    filters.push({
      sql: `NOT (stage = 6 AND UPPER(COALESCE(error_code, '')) IN ('REGIME_PROHIBITED', 'HTF_CONFLICT'))`,
      binds: [],
    });
  }
  addStage9DeviceFilter(filters, scope.deviceSessionHash);
  const where = buildWhereClause(filters);

  const [countRes, rowsRes] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM data_quality_incidents ${where.whereSql}`).bind(...where.params).first<{ total: number }>(),
    db
      .prepare(`SELECT * FROM data_quality_incidents ${where.whereSql} ORDER BY last_seen_at_ms DESC LIMIT ? OFFSET ?`)
      .bind(...where.params, limit, offset)
      .all<any>(),
  ]);

  return {
    status: 200,
    body: {
      ok: true,
      readOnly: true,
      total: Number(countRes?.total ?? 0),
      limit,
      offset,
      items: (rowsRes.results || []).map((r: any) => ({
        fingerprint: r.fingerprint,
        userId: r.user_id ?? null,
        androidDeviceSessionHash: r.android_device_session_hash ?? null,
        stage: r.stage,
        component: r.component,
        eventType: r.event_type,
        severity: r.severity,
        errorCode: r.error_code ?? null,
        symbol: r.symbol ?? null,
        strategyId: r.strategy_id ?? null,
        firstSeenAtMs: r.first_seen_at_ms,
        lastSeenAtMs: r.last_seen_at_ms,
        occurrenceCount: r.occurrence_count,
        latestTraceId: r.latest_trace_id ?? null,
        latestCycleId: r.latest_cycle_id ?? null,
        latestDiscoveryCycleId: r.latest_discovery_cycle_id ?? null,
        latestMessage: r.latest_message,
        samplePayload: safeJsonParse(r.sample_payload_json),
      })),
    },
  };
}

async function handleIncidentDetail(rawId: string, env: MonitoringEnv, scope: TenantScope): Promise<QueryResult> {
  const db = env.MONITORING_DB;
  const fingerprint = decodeURIComponent(rawId).trim();
  if (!fingerprint) return { status: 400, body: { error: 'Incident fingerprint is required' } };

  const incFilters: FilterItem[] = [
    { sql: 'fingerprint = ?', binds: [fingerprint] },
    { sql: 'user_id = ?', value: scope.userId },
  ];
  addStage9DeviceFilter(incFilters, scope.deviceSessionHash);
  const incWhere = buildWhereClause(incFilters);

  const inc = await db
    .prepare(`SELECT * FROM data_quality_incidents ${incWhere.whereSql} LIMIT 1`)
    .bind(...incWhere.params)
    .first<any>();

  if (!inc) {
    return { status: 404, body: { error: `Incident '${fingerprint}' not found` } };
  }

  const spanFilters: FilterItem[] = [
    { sql: 'stage = ?', binds: [inc.stage] },
    { sql: 'component = ?', binds: [inc.component] },
    { sql: 'event_type = ?', binds: [inc.event_type] },
    { sql: 'user_id = ?', value: scope.userId },
  ];
  addStage9DeviceFilter(spanFilters, scope.deviceSessionHash);
  const spanWhere = buildWhereClause(spanFilters);

  const relatedSpansRes = await db
    .prepare(
      `SELECT * FROM stage_spans
       ${spanWhere.whereSql}
       ORDER BY emitted_at_ms DESC
       LIMIT 20`
    )
    .bind(...spanWhere.params)
    .all<any>();

  return {
    status: 200,
    body: {
      ok: true,
      readOnly: true,
      incident: {
        fingerprint: inc.fingerprint,
        userId: inc.user_id ?? null,
        androidDeviceSessionHash: inc.android_device_session_hash ?? null,
        stage: inc.stage,
        component: inc.component,
        eventType: inc.event_type,
        severity: inc.severity,
        errorCode: inc.error_code ?? null,
        symbol: inc.symbol ?? null,
        strategyId: inc.strategy_id ?? null,
        firstSeenAtMs: inc.first_seen_at_ms,
        lastSeenAtMs: inc.last_seen_at_ms,
        occurrenceCount: inc.occurrence_count,
        latestTraceId: inc.latest_trace_id ?? null,
        latestCycleId: inc.latest_cycle_id ?? null,
        latestDiscoveryCycleId: inc.latest_discovery_cycle_id ?? null,
        latestMessage: inc.latest_message,
        samplePayload: safeJsonParse(inc.sample_payload_json),
      },
      recentOccurrences: (relatedSpansRes.results || []).map(mapSpanRow),
    },
  };
}

async function handleSelfHealth(env: MonitoringEnv, scope: TenantScope): Promise<QueryResult> {
  const db = env.MONITORING_DB;
  const isGlobalOperator = scope.isOperator && !scope.userId;

  const userWhere = scope.userId ? ` WHERE user_id = ?` : '';
  const userBind = scope.userId ? [scope.userId] : [];
  const notifWhere = buildWhereClause([
    { sql: 'user_id = ?', value: scope.userId },
    ...(scope.deviceSessionHash
      ? (() => {
          const arr: FilterItem[] = [];
          addNotificationDeviceFilter(arr, scope);
          return arr;
        })()
      : []),
  ]);
  const spanFilters: FilterItem[] = [{ sql: 'user_id = ?', value: scope.userId }];
  addStage9DeviceFilter(spanFilters, scope.deviceSessionHash);
  const spanWhere = buildWhereClause(spanFilters);
  const incFilters: FilterItem[] = [{ sql: 'user_id = ?', value: scope.userId }];
  addStage9DeviceFilter(incFilters, scope.deviceSessionHash);
  const incWhere = buildWhereClause(incFilters);

  const [healthRows, dlqSummary, dlqRecent, cyclesCnt, spansCnt, taCnt, tradesCnt, notifsCnt, incCnt] = await Promise.all([
    isGlobalOperator
      ? db.prepare(`SELECT * FROM monitoring_self_health ORDER BY updated_at_ms DESC LIMIT 25`).all<any>()
      : Promise.resolve({ results: [] }),
    isGlobalOperator
      ? db.prepare(`SELECT COUNT(*) AS count, MAX(received_at_ms) AS latest_ms FROM telemetry_dlq_records`).first<any>()
      : Promise.resolve({ count: 0, latest_ms: null }),
    isGlobalOperator
      ? db.prepare(`SELECT * FROM telemetry_dlq_records ORDER BY received_at_ms DESC LIMIT 10`).all<any>()
      : Promise.resolve({ results: [] }),
    db.prepare(`SELECT COUNT(*) AS count FROM pipeline_cycles${userWhere}`).bind(...userBind).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM stage_spans ${spanWhere.whereSql}`).bind(...spanWhere.params).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM ta_indicator_snapshots${userWhere}`).bind(...userBind).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM trade_lifecycle_ledger${userWhere}`).bind(...userBind).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM notification_parity_ledger ${notifWhere.whereSql}`).bind(...notifWhere.params).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM data_quality_incidents ${incWhere.whereSql}`).bind(...incWhere.params).first<{ count: number }>(),
  ]);

  const consumers = (healthRows.results || []).map((r: any) => ({
    metricKey: r.metric_key,
    eventsReceived: r.events_received,
    eventsInserted: r.events_inserted,
    eventsDeduped: r.events_deduped,
    dlqRouted: r.dlq_routed,
    d1WriteErrors: r.d1_write_errors,
    lastEventEmittedAtMs: r.last_event_emitted_at_ms ?? null,
    lastConsumerProcessedAtMs: r.last_consumer_processed_at_ms ?? null,
    lastD1CommittedAtMs: r.last_d1_committed_at_ms ?? null,
    avgIngestLagMs: asNullableNumber(r.avg_ingest_lag_ms),
    maxIngestLagMs: asNullableNumber(r.max_ingest_lag_ms),
    lastError: r.last_error ?? null,
    producerStats: safeJsonParse(r.producer_stats_json),
    updatedAtMs: r.updated_at_ms,
  }));

  const primary = consumers.find((c) => c.metricKey === 'consumer_global') || consumers[0] || null;
  const dlqCount = Number(dlqSummary?.count ?? 0);

  let honestState: 'NO_DATA' | 'HEALTHY' | 'DLQ_NONZERO' | 'D1_ERRORS' | 'DEGRADED_LAG' | 'SCOPED_REDACTED' =
    isGlobalOperator ? 'NO_DATA' : 'SCOPED_REDACTED';
  if (isGlobalOperator && primary) {
    if (primary.d1WriteErrors > 0) honestState = 'D1_ERRORS';
    else if (dlqCount > 0) honestState = 'DLQ_NONZERO';
    else if ((primary.maxIngestLagMs ?? 0) > 15_000) honestState = 'DEGRADED_LAG';
    else honestState = 'HEALTHY';
  }

  return {
    status: 200,
    body: {
      ok: true,
      readOnly: true,
      scopedToUser: Boolean(scope.userId),
      honestState,
      consumerHealth: consumers,
      dlqSummary: dlqSummary || { count: 0, latest_ms: null },
      recentDlqRecords: (dlqRecent.results || []).map((d: any) => ({
        dlqId: d.dlq_id,
        batchId: d.batch_id ?? null,
        producer: d.producer ?? 'unknown',
        eventCount: d.event_count,
        failureReason: d.failure_reason,
        retryAttempts: d.retry_attempts,
        receivedAtMs: d.received_at_ms,
        rawPreview: safeJsonParse(d.raw_preview_json),
      })),
      tableCounts: {
        pipelineCycles: Number(cyclesCnt?.count ?? 0),
        stageSpans: Number(spansCnt?.count ?? 0),
        taSnapshots: Number(taCnt?.count ?? 0),
        trades: Number(tradesCnt?.count ?? 0),
        notifications: Number(notifsCnt?.count ?? 0),
        incidents: Number(incCnt?.count ?? 0),
      },
    },
  };
}

async function handleLiveProbe(request: Request, _url: URL, env: MonitoringEnv, scope: TenantScope): Promise<QueryResult> {
  const db = env.MONITORING_DB;

  const cycleWhere = scope.userId ? `WHERE user_id = ?` : '';
  const cycleBind = scope.userId ? [scope.userId] : [];
  const hbFilters: FilterItem[] = [
    {
      sql: scope.userId
        ? `component = 'TradingBot'`
        : `component IN ('TradingBot', 'PublicMarketDataCoordinator', 'PublicMarketDataService')`,
      binds: [],
    },
    { sql: 'user_id = ?', value: scope.userId },
  ];
  addStage9DeviceFilter(hbFilters, scope.deviceSessionHash);
  const hbWhere = buildWhereClause(hbFilters);

  const [latestCyclesRes, latestHeartbeatsRes] = await Promise.all([
    db
      .prepare(`SELECT user_id, bot_id, journey, cycle_id, trace_id, overall_status, updated_at_ms FROM pipeline_cycles ${cycleWhere} ORDER BY updated_at_ms DESC LIMIT 3`)
      .bind(...cycleBind)
      .all<any>(),
    db
      .prepare(
        `SELECT span_id, stage, component, event_type, status, emitted_at_ms, message, output_summary_json
         FROM stage_spans
         ${hbWhere.whereSql}
         ORDER BY emitted_at_ms DESC
         LIMIT 10`
      )
      .bind(...hbWhere.params)
      .all<any>(),
  ]);

  const effectiveUserId = scope.isOperator
    ? scope.userId ||
      ((latestCyclesRes.results || []).find((c: any) => typeof c.user_id === 'string' && c.user_id)?.user_id ?? null)
    : scope.userId;

  let backendProbeStatus: 'CONNECTED' | 'BACKEND_SERVICE_UNBOUND' | 'UNAVAILABLE' = 'BACKEND_SERVICE_UNBOUND';
  let coordinatorStats: unknown = null;
  let tradingBotState: unknown = null;
  let workerHealth: unknown = null;
  let probeError: string | null = null;

  if (env.BACKEND_SERVICE) {
    try {
      const fwdHeaders = new Headers();
      const auth = request.headers.get('Authorization');
      const adminKey = request.headers.get('X-Admin-Key');
      if (auth) fwdHeaders.set('Authorization', auth);
      if (adminKey && scope.isOperator) fwdHeaders.set('X-Admin-Key', adminKey);

      const query = effectiveUserId ? `?userId=${encodeURIComponent(effectiveUserId)}` : '';
      const res = await env.BACKEND_SERVICE.fetch(`https://backend/api/admin/monitoring/health${query}`, {
        method: 'GET',
        headers: fwdHeaders,
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        backendProbeStatus = 'CONNECTED';
        coordinatorStats = scope.isOperator ? (data?.publicMarketCoordinator ?? null) : null;
        tradingBotState = data?.tradingBotState ?? null;
        workerHealth = scope.isOperator
          ? {
              worker: data?.worker ?? null,
              d1Database: data?.d1Database ?? null,
              timestamp: data?.timestamp ?? null,
            }
          : null;
      } else {
        backendProbeStatus = 'UNAVAILABLE';
        probeError = `Backend probe returned HTTP ${res.status}`;
      }
    } catch (err: any) {
      backendProbeStatus = 'UNAVAILABLE';
      probeError = err?.message || 'Backend service probe failed';
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      readOnly: true,
      probedAtMs: Date.now(),
      neverCallsExchange: true,
      requestedUserId: effectiveUserId,
      backendProbeStatus,
      probeError,
      workerHealth,
      coordinatorStats,
      tradingBotState,
      recentHeartbeats: (latestHeartbeatsRes.results || []).map(mapSpanRow),
    },
  };
}

export async function handleMonitorQueryV2(
  request: Request,
  url: URL,
  env: MonitoringEnv,
  principal: AdminPrincipal
): Promise<QueryResult | null> {
  const path = url.pathname;
  if (!path.startsWith('/api/monitor/v2/')) return null;
  if (request.method !== 'GET') {
    return { status: 405, body: { error: 'Method Not Allowed: monitoring API is strictly read-only', readOnly: true } };
  }

  const resolved = resolveTenantScope(url, principal);
  if (!resolved.ok) return resolved.res;
  const scope = resolved.scope;

  const sub = path.slice('/api/monitor/v2/'.length).replace(/\/+$/, '');
  if (!sub || sub === 'overview') return handleOverview(url, env, scope);
  if (sub === 'traces') return handleTracesList(url, env, scope);
  if (sub.startsWith('traces/')) return handleTraceDetail(sub.slice('traces/'.length), env, scope);
  if (sub === 'ta') return handleTaAndStage2(url, env, scope);
  if (sub === 'strategies-gates') return handleStrategiesAndGates(url, env, scope);
  if (sub === 'trades') return handleTradesList(url, env, scope);
  if (sub.startsWith('trades/')) return handleTradeDetail(sub.slice('trades/'.length), env, scope);
  if (sub === 'notifications') return handleNotifications(url, env, scope);
  if (sub === 'incidents') return handleIncidentsList(url, env, scope);
  if (sub.startsWith('incidents/')) return handleIncidentDetail(sub.slice('incidents/'.length), env, scope);
  if (sub === 'self-health') return handleSelfHealth(env, scope);
  if (sub === 'live-probe') return handleLiveProbe(request, url, env, scope);

  return { status: 404, body: { error: `Unknown monitor v2 route: ${path}` } };
}
