/**
 * BackendDiagnosticSink.ts
 *
 * Non-blocking, backend-aware diagnostic telemetry sink for autonomous trading operations.
 *
 * ABSOLUTE INVARIANT:
 * Telemetry failure != Trading failure
 *
 * - Never awaited from the trading decision or execution path.
 * - Entirely isolated: failures in D1, serialization, or buffer overflow are silently swallowed.
 * - Zero sensitive financial data: strips balances, wallet identifiers, exposure amounts, credentials.
 * - Bounded memory: hard-capped in-memory buffer (100 events max).
 * - Background persistence: uses Cloudflare Durable Object state.waitUntil() or executionCtx.waitUntil().
 */

export type BotTelemetryCategory =
  | 'SCANNER'
  | 'CYCLE'
  | 'STRATEGY'
  | 'RISK'
  | 'SAFETY'
  | 'ALERT'
  | 'NOTIFICATION'
  | 'EXECUTION'
  | 'EXCHANGE';

export type BotTelemetrySeverity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export interface BotTelemetryEvent {
  id?: string;
  userId: string;
  timestamp?: number;
  category: BotTelemetryCategory;
  component: string;
  eventName: string;
  severity?: BotTelemetrySeverity;
  correlationId?: string | null;
  cycleId?: string | null;
  symbol?: string | null;
  strategyId?: string | null;
  durationMs?: number | null;
  payload: Record<string, unknown>;
}

export interface BackendDiagnosticSinkOptions {
  db?: D1Database | null;
  waitUntil?: (promise: Promise<any>) => void;
  disableTelemetry?: boolean;
}

export const EVENT_PAYLOAD_ALLOWLIST: Record<string, readonly string[]> = {
  CYCLE_HEARTBEAT: ['isActive', 'monitoredSymbolsCount', 'pendingAlertsCount', 'strategy'],
  STRATEGY_EVALUATION: ['hasSignal', 'signalType', 'confidenceScore', 'errorCode'],
  FINAL_DISPATCH_GATE: ['passed', 'gate', 'existingAlertId', 'existingPositionId', 'existingStatus', 'side', 'regime'],
  ALERT_CREATED: ['alertId', 'side', 'signalPrice', 'stopLoss', 'takeProfit', 'confidenceScore'],
  FCM_DISPATCH_RESULT: ['alertId', 'success', 'transport', 'httpStatus', 'errorCode'],
  EXECUTION_REQUEST: ['alertId', 'clientOrderId', 'symbol', 'side', 'orderType', 'entryIntent'],
  BYBIT_RESULT: ['success', 'orderId', 'orderStatus', 'resultCode']
};

export class BackendDiagnosticSink {
  private db: D1Database | null = null;
  private waitUntilFn: ((promise: Promise<any>) => void) | null = null;
  private isTelemetryDisabled = false;

  private readonly buffer: BotTelemetryEvent[] = [];
  private isFlushing = false;
  private lastPruneTimestamp = 0;

  private static readonly MAX_BUFFER_SIZE = 100;
  private static readonly BATCH_TRIGGER_SIZE = 10;
  private static readonly MAX_BATCH_DISPATCH = 25;
  private static readonly RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  private static readonly PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // Once per 24 hours
  private static readonly MAX_STRING_LENGTH = 256;
  private static readonly MAX_SERIALIZED_BYTES = 1024;

  private static readonly FORBIDDEN_KEY_PATTERNS = new Set([
    'apikey',
    'apisecret',
    'apipassphrase',
    'password',
    'confirmpassword',
    'accesstoken',
    'refreshtoken',
    'authorization',
    'pin',
    'recoverycode',
    'privatekey',
    'seedphrase',
    'secretkey',
    'encryptionkey',
    'xbapiapikey',
    'xbapisign',
    'fcmtoken',
    'balance',
    'balances',
    'walletbalance',
    'accountbalance',
    'accountbalanceusdt',
    'totalbalance',
    'networth',
    'portfolio',
    'wallet',
    'wallets',
    'total',
    'free',
    'equity',
    'maxexposureusdt',
    'currentexposureusdt',
    'notionalusdt',
    'proposednotional',
    'walletaddress',
    'accountnumber'
  ]);

  constructor(options?: BackendDiagnosticSinkOptions) {
    if (options?.db) this.db = options.db;
    if (options?.waitUntil) this.waitUntilFn = options.waitUntil;
    if (options?.disableTelemetry !== undefined) {
      this.isTelemetryDisabled = options.disableTelemetry;
    }
  }

  public configure(options: BackendDiagnosticSinkOptions): void {
    if (options.db !== undefined) this.db = options.db;
    if (options.waitUntil !== undefined) this.waitUntilFn = options.waitUntil;
    if (options.disableTelemetry !== undefined) this.isTelemetryDisabled = options.disableTelemetry;
  }

  /**
   * Synchronous, non-blocking telemetry emitter.
   * NEVER returns a Promise. The caller cannot await this method.
   * Total failure isolation: any internal error is caught and swallowed.
   */
  public emit(event: BotTelemetryEvent): void {
    if (this.isTelemetryDisabled) return;

    try {
      if (!event.userId || !event.category || !event.eventName) {
        return;
      }

      // Enforce primary allowlist and secondary recursive sanitizer
      const sanitizedPayload = this.filterAndSanitizePayload(event.eventName, event.payload || {});

      const normalizedEvent: BotTelemetryEvent = {
        id: event.id || crypto.randomUUID(),
        userId: String(event.userId),
        timestamp: event.timestamp || Date.now(),
        category: event.category,
        component: String(event.component || 'TradingBot').slice(0, 100),
        eventName: String(event.eventName).slice(0, 100),
        severity: event.severity || 'INFO',
        correlationId: event.correlationId ? String(event.correlationId).slice(0, 100) : null,
        cycleId: event.cycleId ? String(event.cycleId).slice(0, 100) : null,
        symbol: event.symbol ? String(event.symbol).slice(0, 30) : null,
        strategyId: event.strategyId ? String(event.strategyId).slice(0, 50) : null,
        durationMs: typeof event.durationMs === 'number' ? Math.round(event.durationMs) : null,
        payload: sanitizedPayload
      };

      // Push into bounded buffer with FIFO overflow protection (Ring Buffer of 100 items)
      if (this.buffer.length >= BackendDiagnosticSink.MAX_BUFFER_SIZE) {
        this.buffer.shift(); // Evict oldest event
      }
      this.buffer.push(normalizedEvent);

      // Decoupled Diagnostic Telemetry: Stream to Worker console (0 D1 row reads/writes)
      const payloadStr = JSON.stringify(normalizedEvent.payload);
      if (normalizedEvent.severity === 'ERROR' || normalizedEvent.severity === 'CRITICAL') {
        console.error(`[DIAGNOSTIC] [${normalizedEvent.severity}] [${normalizedEvent.category}] ${normalizedEvent.eventName}: ${payloadStr}`);
      } else {
        console.log(`[DIAGNOSTIC] [${normalizedEvent.category}] ${normalizedEvent.eventName}: ${payloadStr}`);
      }
    } catch (_) {
      // Intentionally swallowed: Diagnostics must NEVER compromise engine execution
    }
  }

  /**
   * Returns recent in-memory diagnostic events for status inspection.
   */
  public getRecentEvents(limit = 50): BotTelemetryEvent[] {
    return this.buffer.slice(-limit);
  }

  /**
   * Retained as no-op for backward compatibility.
   * Diagnostic telemetry is completely decoupled from D1.
   */
  private scheduleFlush(): void {
    // No-op: D1 telemetry persistence decoupled for lifetime-free operation
  }

  /**
   * Retained as no-op for backward compatibility.
   */
  private async persistBatch(_events: BotTelemetryEvent[]): Promise<void> {
    // No-op: D1 telemetry persistence decoupled for lifetime-free operation
  }

  /**
   * Primary security boundary: filter payload against strict allowlist, then sanitize.
   */
  public filterAndSanitizePayload(eventName: string, rawPayload: Record<string, unknown>): Record<string, unknown> {
    const allowedKeys = EVENT_PAYLOAD_ALLOWLIST[eventName];
    if (!allowedKeys || !rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      return {};
    }

    const filtered: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(rawPayload, key)) {
        const val = rawPayload[key];
        if (val !== undefined) {
          filtered[key] = val;
        }
      }
    }

    // Secondary defense-in-depth: recursive sanitizer + string length capping
    const sanitized = this.sanitizeObject(filtered);

    // Byte size check (hard cap at 1024 bytes)
    try {
      const serialized = JSON.stringify(sanitized);
      if (serialized.length > BackendDiagnosticSink.MAX_SERIALIZED_BYTES) {
        return { truncated: true, eventName };
      }
    } catch (_) {
      return {};
    }

    return sanitized;
  }

  /**
   * Deep payload sanitizer ensuring zero sensitive financial data and zero credentials.
   */
  public sanitizeObject(obj: unknown): Record<string, unknown> {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return {};
    }

    const clean: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const cleanKey = key.toLowerCase().replace(/[-_]/g, '');

      if (BackendDiagnosticSink.FORBIDDEN_KEY_PATTERNS.has(cleanKey)) {
        // Drop forbidden keys completely
        continue;
      }

      if (typeof value === 'string') {
        clean[key] = value.slice(0, BackendDiagnosticSink.MAX_STRING_LENGTH);
      } else if (value !== null && typeof value === 'object') {
        if (Array.isArray(value)) {
          clean[key] = value.map((item) =>
            typeof item === 'object' && item !== null
              ? this.sanitizeObject(item)
              : typeof item === 'string'
              ? item.slice(0, BackendDiagnosticSink.MAX_STRING_LENGTH)
              : item
          );
        } else {
          clean[key] = this.sanitizeObject(value);
        }
      } else {
        clean[key] = value;
      }
    }

    return clean;
  }

  /**
   * Exposed strictly for unit testing buffer management.
   */
  public getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Exposed strictly for testing / graceful shutdown.
   */
  public async flushSyncForTesting(): Promise<void> {
    this.buffer.length = 0;
  }
}
