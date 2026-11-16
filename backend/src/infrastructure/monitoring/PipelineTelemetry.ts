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
  const queue = isDisabled ? null : ((env?.TELEMETRY_QUEUE as TelemetryIngestBinding | undefined) ?? defaultQueue);
  const httpFallback = isDisabled
    ? null
    : ((env?.MONITOR_INGEST_SERVICE as HttpIngestServiceBinding | undefined) ?? defaultHttpFallback);
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
