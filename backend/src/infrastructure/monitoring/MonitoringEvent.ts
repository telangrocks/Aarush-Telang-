/**
 * MonitoringEvent.ts
 *
 * Core data models, validation, and security sanitization for CryptoPulse
 * Centralized Monitoring Platform.
 *
 * STRICT INVARIANT:
 * Zero sensitive data persistence. All incoming events are rigorously
 * sanitized against secrets, credentials, tokens, and private signatures.
 */

export type MonitoringSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export type MonitoringSource = 'BACKEND' | 'BOT' | 'ANDROID' | 'AUTH' | 'INFRASTRUCTURE';

export type BotLifecycleStage =
  | 'MARKET_DATA_ACQUISITION'
  | 'CANDLE_VALIDATION'
  | 'INDICATOR_CALCULATION'
  | 'STRATEGY_EVALUATION'
  | 'MARKET_REGIME_ANALYSIS'
  | 'SIGNAL_ARBITRATION'
  | 'TRADE_VALIDATION'
  | 'RISK_VALIDATION'
  | 'ORDER_PREPARATION'
  | 'EXCHANGE_ORDER_SUBMISSION'
  | 'ORDER_ACKNOWLEDGEMENT'
  | 'POSITION_CREATION'
  | 'PROTECTION_PLACEMENT'
  | 'POSITION_MONITORING'
  | 'EXIT_EXECUTION'
  | 'WAL_RECONCILIATION'
  | 'CIRCUIT_BREAKER';

export type IncidentStatus = 'UNRESOLVED' | 'INVESTIGATING' | 'RESOLVED' | 'IGNORED';

export interface MonitoringEvent {
  id: string;
  timestamp: number;
  fingerprint: string;
  windowBucket?: number;
  severity: MonitoringSeverity;
  source: MonitoringSource;
  environment: string;
  component: string;
  eventType: string;
  userId?: string;
  botId?: string;
  correlationId?: string;
  lifecycleStage?: BotLifecycleStage;
  errorCode?: string;
  message: string;
  evidence?: Record<string, unknown>;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  status: IncidentStatus;
  resolvedAt?: number;
  resolvedBy?: string;
  resolutionNotes?: string;
  appVersion?: string;
  backendVersion?: string;
}

export const FORBIDDEN_KEY_PATTERNS = new Set([
  'apikey',
  'api_key',
  'apisecret',
  'api_secret',
  'secret',
  'password',
  'passphrase',
  'authorization',
  'auth',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'jwt',
  'cookie',
  'session',
  'signature',
  'privatekey',
  'private_key',
  'pin',
  'recoverycode',
  'seedphrase',
  'encryptionkey',
  'encryption_key',
  'xbapiapikey',
  'xbapisign',
  'fcmtoken',
  'fcm_token'
]);

const MAX_PAYLOAD_DEPTH = 5;
const MAX_STRING_LENGTH = 500;
const MAX_SERIALIZED_BYTES = 2048;

/**
 * Sanitizes an arbitrary object or primitive to guarantee no secret or credential is persisted.
 */
export function sanitizeMonitoringPayload(payload: unknown, depth = 0): unknown {
  if (depth > MAX_PAYLOAD_DEPTH || payload === null || payload === undefined) {
    return null;
  }

  if (typeof payload === 'string') {
    return payload.length > MAX_STRING_LENGTH
      ? `${payload.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]`
      : payload;
  }

  if (typeof payload === 'number' || typeof payload === 'boolean') {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.slice(0, 20).map((item) => sanitizeMonitoringPayload(item, depth + 1));
  }

  if (typeof payload === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (FORBIDDEN_KEY_PATTERNS.has(normalizedKey)) {
        clean[key] = '[REDACTED]';
      } else {
        clean[key] = sanitizeMonitoringPayload(value, depth + 1);
      }
    }
    return clean;
  }

  return String(payload);
}

/**
 * Generates a stable deterministic fingerprint string for deduplicating identical incidents.
 */
export function generateEventFingerprint(event: {
  component: string;
  eventType: string;
  errorCode?: string;
  lifecycleStage?: string;
  symbol?: string;
  userId?: string;
}): string {
  const parts = [
    event.component.trim().toUpperCase(),
    event.eventType.trim().toUpperCase(),
    (event.errorCode || '').trim().toUpperCase(),
    (event.lifecycleStage || '').trim().toUpperCase(),
    (event.symbol || '').trim().toUpperCase(),
    event.userId ? event.userId.trim() : 'GLOBAL'
  ];
  return parts.join('::');
}

/**
 * Validates and normalizes an incoming partial monitoring event.
 */
export function validateMonitoringEvent(raw: unknown): {
  valid: boolean;
  event?: MonitoringEvent;
  error?: string;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, error: 'Monitoring event payload must be a non-empty object.' };
  }

  const obj = raw as Record<string, unknown>;

  const severity = String(obj.severity || 'INFO').toUpperCase() as MonitoringSeverity;
  if (!['INFO', 'WARNING', 'ERROR', 'CRITICAL'].includes(severity)) {
    return { valid: false, error: `Invalid severity: ${obj.severity}` };
  }

  const source = String(obj.source || 'BACKEND').toUpperCase() as MonitoringSource;
  if (!['BACKEND', 'BOT', 'ANDROID', 'AUTH', 'INFRASTRUCTURE'].includes(source)) {
    return { valid: false, error: `Invalid source: ${obj.source}` };
  }

  const component = String(obj.component || 'System').trim().slice(0, 100);
  const eventType = String(obj.eventType || 'UNKNOWN_EVENT').trim().slice(0, 100);
  const message = String(obj.message || 'No description provided').trim().slice(0, 500);

  const now = Date.now();
  const timestamp = typeof obj.timestamp === 'number' && obj.timestamp > 0 ? obj.timestamp : now;

  const sanitizedEvidence = obj.evidence
    ? (sanitizeMonitoringPayload(obj.evidence) as Record<string, unknown>)
    : undefined;

  // Enforce byte size constraint on serialized evidence
  if (sanitizedEvidence) {
    const serialized = JSON.stringify(sanitizedEvidence);
    if (serialized.length > MAX_SERIALIZED_BYTES) {
      sanitizedEvidence['_truncated'] = true;
      sanitizedEvidence['_note'] = `Payload size (${serialized.length} bytes) exceeded ${MAX_SERIALIZED_BYTES} byte limit.`;
    }
  }

  const symbol = sanitizedEvidence && typeof sanitizedEvidence.symbol === 'string'
    ? sanitizedEvidence.symbol
    : undefined;

  const fingerprint = (typeof obj.fingerprint === 'string' && obj.fingerprint.length > 0)
    ? obj.fingerprint
    : generateEventFingerprint({
        component,
        eventType,
        errorCode: obj.errorCode ? String(obj.errorCode) : undefined,
        lifecycleStage: obj.lifecycleStage ? String(obj.lifecycleStage) : undefined,
        symbol,
        userId: obj.userId ? String(obj.userId) : undefined
      });

  const normalized: MonitoringEvent = {
    id: typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : `evt_${now}_${Math.random().toString(36).slice(2, 9)}`,
    timestamp,
    fingerprint,
    severity,
    source,
    environment: String(obj.environment || 'production').trim().slice(0, 50),
    component,
    eventType,
    userId: obj.userId ? String(obj.userId).trim().slice(0, 100) : undefined,
    botId: obj.botId ? String(obj.botId).trim().slice(0, 100) : undefined,
    correlationId: obj.correlationId ? String(obj.correlationId).trim().slice(0, 100) : undefined,
    lifecycleStage: obj.lifecycleStage as BotLifecycleStage | undefined,
    errorCode: obj.errorCode ? String(obj.errorCode).trim().slice(0, 100) : undefined,
    message,
    evidence: sanitizedEvidence,
    occurrences: typeof obj.occurrences === 'number' && obj.occurrences >= 1 ? obj.occurrences : 1,
    firstSeenAt: typeof obj.firstSeenAt === 'number' ? obj.firstSeenAt : timestamp,
    lastSeenAt: typeof obj.lastSeenAt === 'number' ? obj.lastSeenAt : timestamp,
    status: (obj.status as IncidentStatus) || 'UNRESOLVED',
    appVersion: obj.appVersion ? String(obj.appVersion).slice(0, 30) : undefined,
    backendVersion: obj.backendVersion ? String(obj.backendVersion).slice(0, 30) : '2.0.0'
  };

  return { valid: true, event: normalized };
}
