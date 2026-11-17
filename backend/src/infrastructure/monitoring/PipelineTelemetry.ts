import { AsyncLocalStorage } from 'node:async_hooks';
import {
  HttpIngestServiceBinding,
  PipelineJourney,
  PipelineStage,
  PipelineTelemetryEvent,
  ProducerDeliveryStats,
  SpanSeverity,
  SpanStatus,
  TelemetryEmitter,
  TelemetryIngestBinding,
  TelemetryTier,
  normalizeEnvironmentMode,
} from '../../../../shared/monitoring';

export type BackendProducerName =
  | 'crypto-pulse-backend'
  | 'trading-bot-do'
  | 'public-market-coordinator'
  | 'android-app';

export interface PipelineTraceContext {
  journey?: PipelineJourney;
  environment?: string;
  userId?: string;
  botId?: string;
  discoveryCycleId?: string;
  approvalGeneration?: number;
  parentApprovalGeneration?: number;
  cycleId?: string;
  traceId?: string;
  candleDatasetId?: string;
  emitter?: TelemetryEmitter;
  disabled?: boolean;
}

export type StageSpanInput = Omit<
  Partial<PipelineTelemetryEvent>,
  'schemaVersion' | 'journey' | 'stage' | 'eventType' | 'status' | 'component' | 'message'
> & {
  stage: PipelineStage;
  eventType: string;
  status: SpanStatus;
  component: string;
  message: string;
  journey?: PipelineJourney;
  tier?: TelemetryTier;
  severity?: SpanSeverity;
};

const traceStorage = new AsyncLocalStorage<PipelineTraceContext>();
const fallbackEmitters = new Map<BackendProducerName, TelemetryEmitter>();

let defaultQueue: TelemetryIngestBinding | null = null;
let defaultHttpFallback: HttpIngestServiceBinding | null = null;
let defaultIngestSecret: string | null = null;
let defaultEnvironment: string | undefined;

export function isTelemetryDisabled(env?: { DISABLE_MONITORING_TELEMETRY?: string } | null): boolean {
  return env?.DISABLE_MONITORING_TELEMETRY === 'true';
}

function readIngestSecret(env?: { INTERNAL_INGEST_SECRET?: unknown } | null): string | null {
  const s = env?.INTERNAL_INGEST_SECRET;
  return typeof s === 'string' && s.length > 0 ? s : null;
}

function getOrCreateFallbackEmitter(producer: BackendProducerName): TelemetryEmitter {
  let existing = fallbackEmitters.get(producer);
  if (!existing) {
    existing = new TelemetryEmitter({
      producer,
      queue: defaultQueue,
      httpFallback: defaultHttpFallback,
      httpIngestSecret: defaultIngestSecret,
      maxBufferSize: 200,
      maxBatchSize: 50,
    });
    fallbackEmitters.set(producer, existing);
  }
  return existing;
}

export function createScopedTelemetryEmitter(
  producer: BackendProducerName,
  env?: {
    TELEMETRY_QUEUE?: unknown;
    MONITOR_INGEST_SERVICE?: unknown;
    INTERNAL_INGEST_SECRET?: unknown;
    ENVIRONMENT?: string;
    DISABLE_MONITORING_TELEMETRY?: string;
  } | null
): TelemetryEmitter {
  const isDisabled = isTelemetryDisabled(env);
  const hasExplicitBindings = Boolean(env && ('TELEMETRY_QUEUE' in env || 'MONITOR_INGEST_SERVICE' in env));
  const queue = isDisabled
    ? null
    : hasExplicitBindings
      ? ((env?.TELEMETRY_QUEUE as TelemetryIngestBinding | undefined) ?? null)
      : defaultQueue;
  const httpFallback = isDisabled
    ? null
    : hasExplicitBindings
      ? ((env?.MONITOR_INGEST_SERVICE as HttpIngestServiceBinding | undefined) ?? null)
      : defaultHttpFallback;
  return new TelemetryEmitter({
    producer,
    queue,
    httpFallback,
    httpIngestSecret: readIngestSecret(env) ?? defaultIngestSecret,
    maxBufferSize: 200,
    maxBatchSize: 50,
    disabled: isDisabled,
  });
}

export function bindTelemetryEnv(
  env?: {
    TELEMETRY_QUEUE?: unknown;
    MONITOR_INGEST_SERVICE?: unknown;
    INTERNAL_INGEST_SECRET?: unknown;
    ENVIRONMENT?: string;
    DISABLE_MONITORING_TELEMETRY?: string;
  } | null,
  producer: BackendProducerName = 'crypto-pulse-backend'
): void {
  try {
    if (!env || isTelemetryDisabled(env)) return;
    if (env.ENVIRONMENT) defaultEnvironment = env.ENVIRONMENT;
    const queue = (env.TELEMETRY_QUEUE as TelemetryIngestBinding | undefined) ?? null;
    const httpFallback = (env.MONITOR_INGEST_SERVICE as HttpIngestServiceBinding | undefined) ?? null;
    const secret = readIngestSecret(env);
    if (queue) defaultQueue = queue;
    if (httpFallback) defaultHttpFallback = httpFallback;
    if (secret) defaultIngestSecret = secret;

    const emitter = getOrCreateFallbackEmitter(producer);
    emitter.updateBindings(queue ?? defaultQueue, httpFallback ?? defaultHttpFallback, secret ?? defaultIngestSecret);
  } catch {
    // Strictly fail-open
  }
}

export function runWithTelemetryContext<T>(ctx: PipelineTraceContext, fn: () => T): T {
  try {
    const parent = traceStorage.getStore();
    const merged: PipelineTraceContext = parent ? { ...parent, ...ctx } : ctx;
    return traceStorage.run(merged, fn);
  } catch {
    return fn();
  }
}

export function getTelemetryContext(): PipelineTraceContext | undefined {
  try {
    return traceStorage.getStore();
  } catch {
    return undefined;
  }
}

export function emitStageSpan(
  input: StageSpanInput,
  overrideEnv?: {
    TELEMETRY_QUEUE?: unknown;
    MONITOR_INGEST_SERVICE?: unknown;
    ENVIRONMENT?: string;
    DISABLE_MONITORING_TELEMETRY?: string;
  } | null
): PipelineTelemetryEvent | null {
  try {
    const ctx = getTelemetryContext();
    if (ctx?.disabled || isTelemetryDisabled(overrideEnv)) {
      return null;
    }
    if (overrideEnv) {
      bindTelemetryEnv(overrideEnv);
    }

    const emitter = ctx?.emitter ?? getOrCreateFallbackEmitter('crypto-pulse-backend');
    if (emitter.isDisabled()) {
      return null;
    }
    const resolvedEnv = input.environment
      ? input.environment
      : normalizeEnvironmentMode(ctx?.environment ?? overrideEnv?.ENVIRONMENT ?? defaultEnvironment);

    return emitter.emit({
      ...input,
      journey: input.journey ?? ctx?.journey ?? 'SYSTEM',
      tier: input.tier ?? (input.stage === 7 || input.stage >= 8 ? 'TIER_1' : 'TIER_2'),
      environment: resolvedEnv,
      userId: input.userId ?? ctx?.userId,
      botId: input.botId ?? ctx?.botId,
      discoveryCycleId: input.discoveryCycleId ?? ctx?.discoveryCycleId,
      approvalGeneration: input.approvalGeneration ?? ctx?.approvalGeneration,
      parentApprovalGeneration: input.parentApprovalGeneration ?? ctx?.parentApprovalGeneration,
      cycleId: input.cycleId ?? ctx?.cycleId,
      traceId: input.traceId ?? ctx?.traceId,
      candleDatasetId: input.candleDatasetId ?? ctx?.candleDatasetId,
    });
  } catch {
    return null;
  }
}

export function flushTelemetry(
  waitUntilFn?: (p: Promise<unknown>) => void,
  explicitEmitter?: TelemetryEmitter
): void {
  try {
    const ctx = getTelemetryContext();
    const target = explicitEmitter ?? ctx?.emitter ?? fallbackEmitters.get('crypto-pulse-backend');
    if (!target || target.isDisabled()) return;
    if (ctx?.disabled && !explicitEmitter) return;
    target.scheduleFlush(waitUntilFn);
  } catch {
    // Strictly fail-open
  }
}

export function getEmitterStatsSnapshot(producer: BackendProducerName): ProducerDeliveryStats | null {
  const emitter = fallbackEmitters.get(producer);
  return emitter ? emitter.getHealthStats() : null;
}

export function getBufferedSnapshot(producer: BackendProducerName): readonly PipelineTelemetryEvent[] {
  const emitter = fallbackEmitters.get(producer);
  return emitter ? emitter.getBufferedEventsSnapshot() : [];
}

export interface StagingIsolationEnv {
  ENVIRONMENT?: unknown;
  STAGING_ISOLATION_MODE?: unknown;
}

export interface StagingConfigValidation {
  isStaging: boolean;
  valid: boolean;
  allowedExchangeEnv: 'demo' | null;
  status: number;
  code: string;
  error: string | null;
}

/**
 * Determines whether the Worker environment has explicit staging isolation configured,
 * and validates that the staging configuration is present and valid ('demo').
 *
 * Production (ENVIRONMENT === 'production' and no STAGING_ISOLATION_MODE) returns
 * { isStaging: false, valid: true, allowedExchangeEnv: null } so production Demo + Real
 * trading remain 100% unrestricted.
 */
export function validateStagingIsolationEnv(env?: StagingIsolationEnv | null): StagingConfigValidation {
  if (!env || typeof env !== 'object') {
    return { isStaging: false, valid: true, allowedExchangeEnv: null, status: 200, code: 'OK', error: null };
  }

  const hasExplicitStagingKey = 'STAGING_ISOLATION_MODE' in env;
  const rawEnv = env.ENVIRONMENT;
  const rawEnvStr = typeof rawEnv === 'string' ? rawEnv.trim().toLowerCase() : null;

  const isProdOrTestEnv =
    rawEnv === undefined ||
    rawEnvStr === 'production' ||
    rawEnvStr === 'test' ||
    rawEnvStr === 'testing';

  if (!hasExplicitStagingKey && isProdOrTestEnv && rawEnvStr !== '') {
    return { isStaging: false, valid: true, allowedExchangeEnv: null, status: 200, code: 'OK', error: null };
  }

  if (hasExplicitStagingKey) {
    const modeStr = typeof env.STAGING_ISOLATION_MODE === 'string' ? env.STAGING_ISOLATION_MODE.trim().toLowerCase() : '';
    if (modeStr !== 'demo' || (rawEnv !== undefined && rawEnvStr !== 'demo')) {
      return {
        isStaging: true,
        valid: false,
        allowedExchangeEnv: null,
        status: 400,
        code: 'INVALID_ENVIRONMENT',
        error: 'Invalid or missing staging environment configuration. Failing closed to prevent Mainnet routing.',
      };
    }
    return { isStaging: true, valid: true, allowedExchangeEnv: 'demo', status: 200, code: 'OK', error: null };
  }

  if (rawEnvStr === 'demo') {
    return { isStaging: true, valid: true, allowedExchangeEnv: 'demo', status: 200, code: 'OK', error: null };
  }

  if (rawEnvStr === 'testnet') {
    return { isStaging: false, valid: true, allowedExchangeEnv: null, status: 200, code: 'OK', error: null };
  }

  return {
    isStaging: true,
    valid: false,
    allowedExchangeEnv: null,
    status: 400,
    code: 'INVALID_ENVIRONMENT',
    error: `Invalid or missing staging ENVIRONMENT ('${String(rawEnv ?? '')}'). Failing closed to prevent Mainnet routing.`,
  };
}

/**
 * Validates a requested or stored exchange environment against the staging isolation policy.
 * When not in staging mode, returns { allowed: true } without restriction.
 * When in staging mode, only 'demo' is permitted; 'mainnet', 'testnet', missing, null, or invalid values fail closed.
 */
export function checkStagingExchangeEnvironment(
  env: StagingIsolationEnv | null | undefined,
  candidateExchangeEnv: unknown,
  options?: { allowUndefined?: boolean }
): { allowed: boolean; status: number; code: string; error: string | null } {
  const cfg = validateStagingIsolationEnv(env);
  if (!cfg.isStaging) {
    return { allowed: true, status: 200, code: 'OK', error: null };
  }
  if (!cfg.valid || !cfg.allowedExchangeEnv) {
    return {
      allowed: false,
      status: cfg.status,
      code: cfg.code,
      error: cfg.error || 'Invalid staging environment configuration.',
    };
  }

  if (candidateExchangeEnv === undefined && options?.allowUndefined) {
    return { allowed: true, status: 200, code: 'OK', error: null };
  }

  const norm = typeof candidateExchangeEnv === 'string' ? candidateExchangeEnv.trim().toLowerCase() : '';
  if (!norm) {
    return {
      allowed: false,
      status: 400,
      code: 'INVALID_ENVIRONMENT',
      error: 'Missing or null exchange environment in staging; failing closed to prevent Mainnet fallback.',
    };
  }

  if (norm === 'mainnet' || norm === 'real' || norm === 'live' || norm === 'production') {
    return {
      allowed: false,
      status: 403,
      code: 'STAGING_MAINNET_BLOCKED',
      error: "Staging environment only permits Bybit Demo ('demo') connections. Mainnet is blocked in staging.",
    };
  }

  if (norm !== cfg.allowedExchangeEnv) {
    return {
      allowed: false,
      status: 400,
      code: 'INVALID_ENVIRONMENT',
      error: `Unsupported exchange environment '${String(candidateExchangeEnv)}' for staging. Only '${cfg.allowedExchangeEnv}' is allowed.`,
    };
  }

  return { allowed: true, status: 200, code: 'OK', error: null };
}
