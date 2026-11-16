/**
 * Shared Telemetry Contracts for CryptoPulse 9-Stage Monitoring System (Screen 2).
 * Shared between crypto-pulse-backend, Durable Objects, and monitoring-worker.
 *
 * ZERO-SECRETS INVARIANT: Contracts strictly forbid secret fields and separate
 * Journey A (Market Discovery) from Journey B (Autonomous Execution).
 */

export type PipelineJourney = 'JOURNEY_A_DISCOVERY' | 'JOURNEY_B_AUTONOMOUS' | 'SYSTEM';

export type PipelineStage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type TelemetryTier = 'TIER_1' | 'TIER_2' | 'TIER_3';

export type SpanStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIPPED' | 'UNKNOWN';

export type SpanSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export type EnvironmentMode = 'mainnet' | 'testnet' | 'demo' | 'unknown';

export type TelemetryDeliveryMilestone =
  | 'EVENT_CREATED'
  | 'QUEUE_SEND_ATTEMPTED'
  | 'QUEUE_ACCEPTED'
  | 'CONSUMER_PROCESSED'
  | 'D1_COMMITTED'
  | 'QUEUE_SEND_FAILED'
  | 'ROUTED_TO_DLQ'
  | 'OVERFLOW_SHED';

export const STAGE9_CONTRACT_VERSION = 1 as const;

export const STAGE9_EVENT_TYPES = {
  FCM_RECEIVED: 'ANDROID_FCM_RECEIVED',
  POLL_RECEIVED: 'ANDROID_POLL_RECEIVED',
  DEDUP_DECISION: 'ANDROID_DEDUP_DECISION',
  NOTIFICATION_PRECHECK: 'ANDROID_NOTIFICATION_PRECHECK',
  NOTIFICATION_POST_CHECK: 'ANDROID_NOTIFICATION_POST_CHECK',
  ALERT_VALIDATED: 'ANDROID_ALERT_VALIDATED',
  POPUP_RENDERED: 'ANDROID_POPUP_RENDERED',
  TELEMETRY_FAILED: 'ANDROID_TELEMETRY_FAILED',
} as const;

export const STAGE9_LEGACY_EVENT_ALIASES = {
  NOTIF_POSTED_VERIFIED: 'ANDROID_NOTIF_POSTED_VERIFIED',
  ALERT_RENDERED: 'ANDROID_ALERT_RENDERED',
} as const;

export const ANDROID_DEDUP_DECISIONS = {
  ACCEPTED: 'ACCEPTED',
  SUPPRESSED: 'SUPPRESSED',
  DUPLICATE_DROPPED: 'DUPLICATE_DROPPED',
} as const;

export const ANDROID_HEADSUP_STATES = {
  UNKNOWN: 'UNKNOWN',
  ELIGIBLE_OS_UNPROVABLE: 'ELIGIBLE_OS_UNPROVABLE',
  SUPPRESSED_PRECHECK: 'SUPPRESSED_PRECHECK',
  POST_CHECK_MISSING: 'POST_CHECK_MISSING',
} as const;

export const ANDROID_VALIDATION_OUTCOMES = {
  PASS: 'PASS',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  VALIDATED: 'VALIDATED',
} as const;

export const PARITY_STATUSES = {
  PARITY_OK: 'PARITY_OK',
  PARITY_MISMATCH: 'PARITY_MISMATCH',
  PENDING_ANDROID: 'PENDING_ANDROID',
  PENDING_BACKEND: 'PENDING_BACKEND',
  DROPPED_ON_ANDROID: 'DROPPED_ON_ANDROID',
  FCM_FAILED: 'FCM_FAILED',
} as const;

export type ParityStatus = (typeof PARITY_STATUSES)[keyof typeof PARITY_STATUSES];
export type AndroidHeadsUpState = (typeof ANDROID_HEADSUP_STATES)[keyof typeof ANDROID_HEADSUP_STATES];

export interface PipelineTelemetryEvent {
  schemaVersion: 2;
  contractVersion?: number;
  spanId: string;
  spanGroupId?: string;
  attemptNumber?: number;

  journey: PipelineJourney;
  stage: PipelineStage;
  tier: TelemetryTier;
  eventType: string;
  status: SpanStatus;
  severity: SpanSeverity;
  environment: EnvironmentMode;

  userId?: string;
  botId?: string;

  // Explicit parent-child / cross-stage causal correlation keys
  discoveryCycleId?: string;
  parentApprovalGeneration?: number;
  approvalGeneration?: number;
  cycleId?: string;
  traceId?: string;
  stageSeq: number;
  candleDatasetId?: string;
  alertId?: string;
  intentId?: string;
  clientOrderId?: string;
  orderId?: string;
  fcmMessageId?: string;
  androidDeviceSessionHash?: string;

  // Monotonic timing + delivery pipeline proof
  emittedAtMs: number;
  durationMs?: number;
  deliveryMilestone: TelemetryDeliveryMilestone;

  // Domain context
  symbol?: string;
  timeframe?: string;
  strategyId?: string;
  component: string;
  sourceFile?: string;
  errorCode?: string;
  message: string;

  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ProducerDeliveryStats {
  eventsCreated: number;
  queueSendAttempted: number;
  queueAccepted: number;
  queueSendFailed: number;
  httpFallbackSucceeded: number;
  httpFallbackFailed: number;
  tier3ShedCount: number;
  overflowDropCount: number;
  lastEventCreatedAtMs: number | null;
  lastQueueAttemptAtMs: number | null;
  lastQueueAcceptedAtMs: number | null;
  lastError: string | null;
}

export interface TelemetryQueueEnvelope {
  batchId: string;
  producer: 'crypto-pulse-backend' | 'trading-bot-do' | 'public-market-coordinator' | 'android-client' | 'tail-worker' | string;
  producedAtMs: number;
  producerStats?: Partial<ProducerDeliveryStats>;
  events: PipelineTelemetryEvent[];
}

export interface TelemetryIngestBinding {
  send(message: TelemetryQueueEnvelope): Promise<unknown>;
  sendBatch?(messages: Iterable<{ body: TelemetryQueueEnvelope }>): Promise<unknown>;
}

export interface HttpIngestServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export const STAGE_LABELS: Record<PipelineStage, string> = {
  1: 'Bybit Connectivity & Raw Data',
  2: 'Budget & Symbol Eligibility',
  3: 'Candle Retrieval & Distribution',
  4: 'Technical Analysis Engine',
  5: 'Autonomous Strategy Evaluation',
  6: 'Safety Gates & Trade Validation',
  7: 'Trade Execution & Bybit Confirm',
  8: 'Backend Notification & FCM',
  9: 'Android Notification & Popup',
};

export const MONITORING_RETENTION_MS = {
  TIER_1_EXECUTION: 90 * 24 * 60 * 60 * 1000, // 90 days
  GATES_AND_NOTIFICATIONS: 30 * 24 * 60 * 60 * 1000, // 30 days
  INCIDENTS: 30 * 24 * 60 * 60 * 1000, // 30 days
  DIAGNOSTIC_SPANS: 14 * 24 * 60 * 60 * 1000, // 14 days
  DLQ_RECORDS: 30 * 24 * 60 * 60 * 1000, // 30 days
} as const;

/**
 * Single source of truth for whether a Stage 9 event actually confirms
 * Android popup rendering (never infers rendering when `rendered === false`).
 */
export function isStage9PopupRenderedEvent(
  ev: Pick<PipelineTelemetryEvent, 'stage' | 'eventType' | 'outputSummary'>
): boolean {
  if (ev.stage !== 9) return false;
  if (
    ev.eventType !== STAGE9_EVENT_TYPES.POPUP_RENDERED &&
    ev.eventType !== STAGE9_LEGACY_EVENT_ALIASES.ALERT_RENDERED
  ) {
    return false;
  }
  const out = (ev.outputSummary || {}) as Record<string, unknown>;
  if (out.rendered === false) return false;
  if (out.rendered === true) return true;
  return Boolean(out.renderedFields && typeof out.renderedFields === 'object' && !Array.isArray(out.renderedFields));
}

/**
 * Single source of truth for whether a Stage 9 event genuinely confirms
 * Android delivery/presentation (notification post-check verified OR popup rendered).
 * Never treats suppressed/rejected/post-check-missing/telemetry-failed as confirmed.
 */
export function isStage9ConfirmedEvent(
  ev: Pick<PipelineTelemetryEvent, 'stage' | 'eventType' | 'status' | 'outputSummary'>
): boolean {
  if (ev.stage !== 9) return false;
  const out = (ev.outputSummary || {}) as Record<string, unknown>;
  if (isStage9PopupRenderedEvent(ev)) {
    return true;
  }
  if (ev.eventType === STAGE9_EVENT_TYPES.NOTIFICATION_POST_CHECK) {
    return (
      out.postNotifyVerified === true &&
      out.androidOsHeadsUpState !== ANDROID_HEADSUP_STATES.SUPPRESSED_PRECHECK &&
      out.notificationsEnabled !== false
    );
  }
  if (ev.eventType === STAGE9_LEGACY_EVENT_ALIASES.NOTIF_POSTED_VERIFIED) {
    return out.postNotifyVerified !== false;
  }
  return false;
}
