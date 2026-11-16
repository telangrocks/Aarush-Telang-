import { PipelineTelemetryEvent, SpanSeverity, SpanStatus, TelemetryTier, EnvironmentMode } from './contracts';

/**
 * Case-insensitive normalized forbidden keys that MUST never enter monitoring telemetry.
 */
export const FORBIDDEN_TELEMETRY_KEYS = new Set([
  'apikey',
  'api_key',
  'apisecret',
  'api_secret',
  'secret',
  'password',
  'confirmpassword',
  'passphrase',
  'apipassphrase',
  'authorization',
  'auth',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'jwt',
  'cookie',
  'setcookie',
  'session',
  'sessiontoken',
  'signature',
  'privatekey',
  'private_key',
  'pin',
  'recoverycode',
  'seedphrase',
  'mnemonic',
  'encryptionkey',
  'encryption_key',
  'xbapiapikey',
  'xbapisign',
  'x_bapi_api_key',
  'x_bapi_sign',
  'fcmtoken',
  'fcm_token',
  'googleclientemail',
  'fcmprivatekey',
  'fcmserverkey',
  'xadminkey',
  'x_admin_key',
  'adminapikey',
  'adminpasswordhash',
]);

export const MAX_TELEMETRY_SECTION_BYTES = 2048;
export const MAX_MESSAGE_CHARS = 500;
const MAX_DEPTH = 5;
const MAX_STRING_CHARS = 360;
const MAX_ARRAY_ITEMS = 25;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

export function isForbiddenKey(key: string): boolean {
  const clean = normalizeKey(key);
  if (FORBIDDEN_TELEMETRY_KEYS.has(clean)) return true;
  if (clean.includes('secret') || clean.includes('password') || clean.includes('privatekey')) return true;
  if (clean.endsWith('token') && clean !== 'fcmtokenpresent' && clean !== 'fcmtokenhash8' && !clean.startsWith('tokens')) {
    return true;
  }
  if (clean === 'apikey' || clean.endsWith('apikey')) return true;
  return false;
}

export function scrubSensitiveString(input: string): string {
  let out = input
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/key=[A-Za-z0-9\-._~+/=]{8,}/gi, 'key=[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]');
  if (out.length > MAX_STRING_CHARS) {
    out = out.slice(0, MAX_STRING_CHARS - 12) + '...[TRUNC]';
  }
  return out;
}

export function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';

  if (typeof value === 'string') return scrubSensitiveString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    const sliced = value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitizeUnknown(v, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      sliced.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    }
    return sliced;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries) {
      if (isForbiddenKey(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeUnknown(v, depth + 1);
      }
    }
    return out;
  }

  return String(value);
}

/**
 * Sanitizes and enforces byte budget on an object section without silently dropping critical metadata.
 */
export function sanitizeAndBoundObject(
  input: Record<string, unknown> | undefined,
  maxBytes = MAX_TELEMETRY_SECTION_BYTES
): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const sanitized = sanitizeUnknown(input, 0) as Record<string, unknown>;
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= maxBytes) {
    return sanitized;
  }

  // Deterministic trim: keep primitive fields first, summarize bulky nested fields/arrays
  const bounded: Record<string, unknown> = { truncationApplied: true, originalBytes: serialized.length };
  let budgetLeft = maxBytes - 120;
  for (const [k, v] of Object.entries(sanitized)) {
    const entryJson = JSON.stringify({ [k]: v });
    if (entryJson.length <= budgetLeft) {
      bounded[k] = v;
      budgetLeft -= entryJson.length;
    } else if (Array.isArray(v)) {
      bounded[k] = { truncatedArrayCount: v.length, sample: v.slice(0, 3) };
    } else if (typeof v === 'string') {
      const cap = Math.max(24, Math.min(80, budgetLeft - k.length - 16));
      bounded[k] = v.slice(0, cap) + '...';
    } else {
      bounded[k] = '[TRUNCATED_OVERSIZE]';
    }
  }
  return bounded;
}

export function normalizeEnvironmentMode(env?: string | null): EnvironmentMode {
  const lower = String(env || '').trim().toLowerCase();
  if (lower === 'mainnet' || lower === 'live' || lower === 'production') return 'mainnet';
  if (lower === 'testnet') return 'testnet';
  if (lower === 'demo' || lower === 'paper' || lower === 'sandbox') return 'demo';
  return 'unknown';
}

export function generateSpanId(prefix = 'spn'): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    }
  } catch (_) {}
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Produces a stable short hex digest (8 chars) for correlation / token identity without leaking secrets.
 */
export async function shortSha256Hex(raw: string, length = 8): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoded = new TextEncoder().encode(raw);
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, length);
    }
  } catch (_) {}
  return syncHashHex(raw, length);
}

export function syncHashHex(raw: string, length = 8): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return hex.slice(0, length);
}

export function computeIncidentFingerprint(event: {
  userId?: string;
  stage: number;
  component: string;
  eventType: string;
  errorCode?: string;
  symbol?: string;
  strategyId?: string;
}): string {
  const base = [
    event.userId || '__system__',
    `s${event.stage}`,
    event.component || 'unknown',
    event.eventType || 'ERROR',
    event.errorCode || 'NONE',
    event.symbol || '*',
    event.strategyId || '*',
  ].join('|');
  return `fp_${syncHashHex(base, 8)}_${syncHashHex(base.split('').reverse().join(''), 8)}`;
}

export function sanitizeTelemetryEvent(
  raw: Partial<PipelineTelemetryEvent>
): PipelineTelemetryEvent | null {
  if (!raw || typeof raw !== 'object') return null;

  const stageNum = Number(raw.stage);
  const stage = (stageNum >= 1 && stageNum <= 9 ? Math.trunc(stageNum) : 1) as PipelineTelemetryEvent['stage'];
  const tier: TelemetryTier =
    raw.tier === 'TIER_1' || raw.tier === 'TIER_2' || raw.tier === 'TIER_3' ? raw.tier : 'TIER_2';
  const status: SpanStatus =
    raw.status === 'PASS' ||
    raw.status === 'WARN' ||
    raw.status === 'FAIL' ||
    raw.status === 'SKIPPED' ||
    raw.status === 'UNKNOWN'
      ? raw.status
      : 'UNKNOWN';
  const severity: SpanSeverity =
    raw.severity === 'INFO' ||
    raw.severity === 'WARNING' ||
    raw.severity === 'ERROR' ||
    raw.severity === 'CRITICAL'
      ? raw.severity
      : status === 'FAIL'
        ? 'ERROR'
        : status === 'WARN'
          ? 'WARNING'
          : 'INFO';

  const message = scrubSensitiveString(String(raw.message || raw.eventType || 'Telemetry event')).slice(
    0,
    MAX_MESSAGE_CHARS
  );

  return {
    schemaVersion: 2,
    contractVersion:
      typeof raw.contractVersion === 'number' && Number.isFinite(raw.contractVersion)
        ? Math.trunc(raw.contractVersion)
        : undefined,
    spanId: typeof raw.spanId === 'string' && raw.spanId.trim() ? raw.spanId.trim().slice(0, 64) : generateSpanId(),
    spanGroupId: raw.spanGroupId ? scrubSensitiveString(String(raw.spanGroupId)).slice(0, 64) : undefined,
    attemptNumber: typeof raw.attemptNumber === 'number' && Number.isFinite(raw.attemptNumber) ? raw.attemptNumber : undefined,
    journey:
      raw.journey === 'JOURNEY_A_DISCOVERY' || raw.journey === 'JOURNEY_B_AUTONOMOUS' || raw.journey === 'SYSTEM'
        ? raw.journey
        : 'SYSTEM',
    stage,
    tier,
    eventType: scrubSensitiveString(String(raw.eventType || 'UNKNOWN_EVENT')).slice(0, 80),
    status,
    severity,
    environment: normalizeEnvironmentMode(raw.environment),
    userId: raw.userId ? scrubSensitiveString(String(raw.userId)).slice(0, 80) : undefined,
    botId: raw.botId ? scrubSensitiveString(String(raw.botId)).slice(0, 80) : undefined,
    discoveryCycleId: raw.discoveryCycleId ? scrubSensitiveString(String(raw.discoveryCycleId)).slice(0, 80) : undefined,
    parentApprovalGeneration:
      typeof raw.parentApprovalGeneration === 'number' && Number.isFinite(raw.parentApprovalGeneration)
        ? raw.parentApprovalGeneration
        : undefined,
    approvalGeneration:
      typeof raw.approvalGeneration === 'number' && Number.isFinite(raw.approvalGeneration)
        ? raw.approvalGeneration
        : undefined,
    cycleId: raw.cycleId ? scrubSensitiveString(String(raw.cycleId)).slice(0, 80) : undefined,
    traceId: raw.traceId ? scrubSensitiveString(String(raw.traceId)).slice(0, 80) : undefined,
    stageSeq: typeof raw.stageSeq === 'number' && Number.isFinite(raw.stageSeq) ? raw.stageSeq : 0,
    candleDatasetId: raw.candleDatasetId ? scrubSensitiveString(String(raw.candleDatasetId)).slice(0, 96) : undefined,
    alertId: raw.alertId ? scrubSensitiveString(String(raw.alertId)).slice(0, 80) : undefined,
    intentId: raw.intentId ? scrubSensitiveString(String(raw.intentId)).slice(0, 80) : undefined,
    clientOrderId: raw.clientOrderId ? scrubSensitiveString(String(raw.clientOrderId)).slice(0, 80) : undefined,
    orderId: raw.orderId ? scrubSensitiveString(String(raw.orderId)).slice(0, 80) : undefined,
    fcmMessageId: raw.fcmMessageId ? scrubSensitiveString(String(raw.fcmMessageId)).slice(0, 128) : undefined,
    androidDeviceSessionHash: raw.androidDeviceSessionHash
      ? scrubSensitiveString(String(raw.androidDeviceSessionHash)).slice(0, 64)
      : undefined,
    emittedAtMs: typeof raw.emittedAtMs === 'number' && Number.isFinite(raw.emittedAtMs) ? raw.emittedAtMs : Date.now(),
    durationMs: typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? raw.durationMs : undefined,
    deliveryMilestone: raw.deliveryMilestone || 'EVENT_CREATED',
    symbol: raw.symbol ? scrubSensitiveString(String(raw.symbol)).slice(0, 32) : undefined,
    timeframe: raw.timeframe ? scrubSensitiveString(String(raw.timeframe)).slice(0, 16) : undefined,
    strategyId: raw.strategyId ? scrubSensitiveString(String(raw.strategyId)).slice(0, 48) : undefined,
    component: scrubSensitiveString(String(raw.component || 'UnknownComponent')).slice(0, 64),
    sourceFile: raw.sourceFile ? scrubSensitiveString(String(raw.sourceFile)).slice(0, 96) : undefined,
    errorCode: raw.errorCode ? scrubSensitiveString(String(raw.errorCode)).slice(0, 64) : undefined,
    message,
    inputSummary: sanitizeAndBoundObject(raw.inputSummary, MAX_TELEMETRY_SECTION_BYTES),
    outputSummary: sanitizeAndBoundObject(raw.outputSummary, MAX_TELEMETRY_SECTION_BYTES),
    metadata: sanitizeAndBoundObject(raw.metadata, MAX_TELEMETRY_SECTION_BYTES),
  };
}
