import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  PipelineTelemetryEvent,
  TelemetryQueueEnvelope,
  generateSpanId,
} from '../../shared/monitoring';
import { handleMonitorFetch } from '../src/index';
import {
  buildGrafanaAuthHeader,
  buildOtlpLogsPayload,
  forwardToGrafana,
  resolveGrafanaLogsEndpoint,
  severityToOtlpSeverityNumber,
} from '../src/grafana-sink';
import { MonitoringEnv } from '../src/types';
import { SqliteD1Database } from './helpers/sqliteD1';

function createMockEvent(overrides: Partial<PipelineTelemetryEvent> = {}): PipelineTelemetryEvent {
  const spanId = generateSpanId('test');
  return {
    schemaVersion: 2,
    spanId,
    journey: 'JOURNEY_B_AUTONOMOUS',
    stage: 7,
    tier: 'TIER_1',
    eventType: 'TRADE_FILLED',
    status: 'PASS',
    severity: 'INFO',
    environment: 'demo',
    stageSeq: 1,
    emittedAtMs: Date.now() - 500,
    durationMs: 120,
    deliveryMilestone: 'EVENT_CREATED',
    symbol: 'BTC/USDT',
    timeframe: '15m',
    strategyId: 'ScalperV2',
    component: 'ExecutionEngine',
    message: 'Order filled on Bybit testnet',
    orderId: 'ord_12345678',
    clientOrderId: 'cp_ord_001',
    userId: 'user-001',
    botId: 'bot-001',
    cycleId: 'CYC-1794966875957',
    traceId: 'trc_1234567890abcdef1234567890abcdef',
    ...overrides,
  };
}

describe('Phase 8 / Grafana Cloud OTLP Sink & Dual-Sink Ingestion', () => {
  let db: SqliteD1Database;
  let env: MonitoringEnv;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    db = new SqliteD1Database();
    env = {
      MONITORING_DB: db,
      ENVIRONMENT: 'demo',
      INTERNAL_INGEST_SECRET: 'test-ingest-secret',
      REQUIRE_INTERNAL_SECRET: 'true',
      GRAFANA_OTLP_ENDPOINT: 'https://otlp-gateway-prod-us-east-0.grafana.net/otlp',
      GRAFANA_INSTANCE_ID: '123456',
      GRAFANA_API_TOKEN: 'glc_eyJvIjoiMTIzNDU2In0=',
      MONITORING_SINK: 'both',
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('1. Endpoint Resolution & Authentication Formatting', () => {
    it('resolves various Grafana Cloud OTLP endpoint formats to /otlp/v1/logs', () => {
      expect(resolveGrafanaLogsEndpoint('https://otlp-gateway.grafana.net/otlp')).toBe(
        'https://otlp-gateway.grafana.net/otlp/v1/logs'
      );
      expect(resolveGrafanaLogsEndpoint('https://otlp-gateway.grafana.net/otlp/')).toBe(
        'https://otlp-gateway.grafana.net/otlp/v1/logs'
      );
      expect(resolveGrafanaLogsEndpoint('https://otlp-gateway.grafana.net/otlp/v1/logs')).toBe(
        'https://otlp-gateway.grafana.net/otlp/v1/logs'
      );
      expect(resolveGrafanaLogsEndpoint('https://otlp-gateway.grafana.net')).toBe(
        'https://otlp-gateway.grafana.net/otlp/v1/logs'
      );
      expect(resolveGrafanaLogsEndpoint('')).toBeNull();
      expect(resolveGrafanaLogsEndpoint(undefined)).toBeNull();
    });

    it('builds standard HTTP Basic Auth header: Basic base64(instance_id:api_token)', () => {
      const header = buildGrafanaAuthHeader({
        ...env,
        GRAFANA_INSTANCE_ID: '888291',
        GRAFANA_API_TOKEN: 'glc_secret_token_123',
      });
      expect(header).toBe(`Basic ${Buffer.from('888291:glc_secret_token_123').toString('base64')}`);
    });

    it('preserves pre-formatted Authorization headers (Bearer / Basic)', () => {
      const basicHeader = buildGrafanaAuthHeader({
        ...env,
        GRAFANA_API_TOKEN: 'Basic dXNlcjpwYXNz',
      });
      expect(basicHeader).toBe('Basic dXNlcjpwYXNz');

      const bearerHeader = buildGrafanaAuthHeader({
        ...env,
        GRAFANA_API_TOKEN: 'Bearer glc_bearer_token',
      });
      expect(bearerHeader).toBe('Bearer glc_bearer_token');
    });

    it('returns null when Grafana credentials are missing', () => {
      expect(buildGrafanaAuthHeader({ ...env, GRAFANA_API_TOKEN: undefined, GRAFANA_INSTANCE_ID: undefined })).toBeNull();
    });

    it('maps severity names to OpenTelemetry specification numbers (1..24)', () => {
      expect(severityToOtlpSeverityNumber('DEBUG')).toBe(5);
      expect(severityToOtlpSeverityNumber('INFO')).toBe(9);
      expect(severityToOtlpSeverityNumber('WARN')).toBe(13);
      expect(severityToOtlpSeverityNumber('WARNING')).toBe(13);
      expect(severityToOtlpSeverityNumber('ERROR')).toBe(17);
      expect(severityToOtlpSeverityNumber('CRITICAL')).toBe(21);
      expect(severityToOtlpSeverityNumber('FATAL')).toBe(21);
      expect(severityToOtlpSeverityNumber(undefined)).toBe(9);
    });
  });

  describe('2. OpenTelemetry OTLP Logs Payload Serialization', () => {
    it('correctly structures ResourceLogs with service attributes and log records', () => {
      const ev1 = createMockEvent({
        stage: 4,
        eventType: 'TA_COMPUTED',
        severity: 'INFO',
        message: 'EMA 9/21 cross confirmed',
        symbol: 'ETH/USDT',
        strategyId: 'Momentum',
      });
      const ev2 = createMockEvent({
        stage: 9,
        eventType: 'ANDROID_POPUP_RENDERED',
        severity: 'INFO',
        message: 'Popup rendered on Android client',
        symbol: 'SOL/USDT',
        androidDeviceSessionHash: 'hash_android_device_99',
      });

      const payload = buildOtlpLogsPayload([ev1, ev2], env, 'crypto-pulse-backend');

      expect(payload.resourceLogs).toHaveLength(1);
      const resLog = payload.resourceLogs[0];

      // Resource attributes
      const resAttrs = Object.fromEntries(resLog.resource.attributes.map((a) => [a.key, a.value.stringValue]));
      expect(resAttrs['service.name']).toBe('cryptopulse-backend');
      expect(resAttrs['service.namespace']).toBe('cryptopulse');
      expect(resAttrs['deployment.environment']).toBe('demo');
      expect(resAttrs['service.instance.id']).toBe('crypto-pulse-backend');

      // Scope & records
      expect(resLog.scopeLogs[0].scope.name).toBe('cryptopulse.monitoring.pipeline');
      expect(resLog.scopeLogs[0].logRecords).toHaveLength(2);

      const record1 = resLog.scopeLogs[0].logRecords[0];
      expect(record1.body.stringValue).toBe('EMA 9/21 cross confirmed');
      expect(record1.severityNumber).toBe(9);
      expect(record1.severityText).toBe('INFO');

      const attrMap1 = Object.fromEntries(
        record1.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue])
      );
      expect(attrMap1['event.type']).toBe('TA_COMPUTED');
      expect(attrMap1['stage']).toBe('4');
      expect(attrMap1['symbol']).toBe('ETH/USDT');
      expect(attrMap1['strategy_id']).toBe('Momentum');

      const record2 = resLog.scopeLogs[0].logRecords[1];
      const attrMap2 = Object.fromEntries(
        record2.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue])
      );
      expect(attrMap2['event.type']).toBe('ANDROID_POPUP_RENDERED');
      expect(attrMap2['android_device_session_hash']).toBe('hash_android_device_99');
    });
  });

  describe('3. Grafana Forwarding: Network, Retries & Safe Fallbacks', () => {
    it('successfully delivers telemetry to Grafana when HTTP 200 is returned', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = mockFetch;

      const envelope: TelemetryQueueEnvelope = {
        batchId: 'bat-001',
        producer: 'crypto-pulse-backend',
        producedAtMs: Date.now(),
        events: [createMockEvent(), createMockEvent()],
      };

      const result = await forwardToGrafana(envelope, env);

      expect(result.ok).toBe(true);
      expect(result.delivered).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.statusCode).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify URL and Headers
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://otlp-gateway-prod-us-east-0.grafana.net/otlp/v1/logs');
      expect(opts.headers['Authorization']).toContain('Basic ');
      expect(opts.headers['Content-Type']).toBe('application/json');
    });

    it('successfully delivers telemetry when HTTP 202 Accepted is returned', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 202 }));

      const envelope: TelemetryQueueEnvelope = {
        batchId: 'bat-002',
        producer: 'crypto-pulse-backend',
        producedAtMs: Date.now(),
        events: [createMockEvent()],
      };

      const result = await forwardToGrafana(envelope, env);
      expect(result.ok).toBe(true);
      expect(result.statusCode).toBe(202);
      expect(result.delivered).toBe(1);
    });

    it('gracefully skips without errors when Grafana endpoint is unconfigured', async () => {
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      const envelope: TelemetryQueueEnvelope = {
        batchId: 'bat-003',
        producer: 'crypto-pulse-backend',
        producedAtMs: Date.now(),
        events: [createMockEvent()],
      };

      const unconfiguredEnv = { ...env, GRAFANA_OTLP_ENDPOINT: undefined };
      const result = await forwardToGrafana(envelope, unconfiguredEnv);

      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.delivered).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('retries once on 500 error and succeeds if second call returns 200', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      globalThis.fetch = mockFetch;

      const envelope: TelemetryQueueEnvelope = {
        batchId: 'bat-004',
        producer: 'crypto-pulse-backend',
        producedAtMs: Date.now(),
        events: [createMockEvent()],
      };

      const result = await forwardToGrafana(envelope, env);
      expect(result.ok).toBe(true);
      expect(result.delivered).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('returns fail result without throwing when Grafana permanently returns 401 Unauthorized', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('Unauthorized token', { status: 401 }));

      const envelope: TelemetryQueueEnvelope = {
        batchId: 'bat-005',
        producer: 'crypto-pulse-backend',
        producedAtMs: Date.now(),
        events: [createMockEvent()],
      };

      const result = await forwardToGrafana(envelope, env);
      expect(result.ok).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(result.failed).toBe(1);
      expect(result.error).toContain('Grafana OTLP HTTP 401');
    });

    it('never throws unhandled exceptions on network timeout or DNS failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND otlp-gateway.grafana.net'));

      const envelope: TelemetryQueueEnvelope = {
        batchId: 'bat-006',
        producer: 'crypto-pulse-backend',
        producedAtMs: Date.now(),
        events: [createMockEvent()],
      };

      const result = await forwardToGrafana(envelope, env);
      expect(result.ok).toBe(false);
      expect(result.delivered).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.error).toContain('ENOTFOUND');
    });
  });

  describe('4. Dual-Sink Ingestion Endpoint Integration (/internal/ingest)', () => {
    it('MONITORING_SINK="both": commits to D1 AND dispatches to Grafana', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = mockFetch;

      const event = createMockEvent({ symbol: 'SOL/USDT', eventType: 'TRADE_INTENT_RESERVED' });
      const req = new Request('http://localhost/internal/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Ingest-Secret': 'test-ingest-secret',
        },
        body: JSON.stringify({
          batchId: 'batch-dual-1',
          producer: 'trading-bot-do',
          producedAtMs: Date.now(),
          events: [event],
        }),
      });

      const res = await handleMonitorFetch(req, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json.ok).toBe(true);
      expect(json.outcome.inserted).toBe(1);
      expect(json.outcome.grafanaDelivered).toBe(1);

      // Verify D1 has the row
      const inDb = await db
        .prepare('SELECT span_id, symbol, event_type FROM stage_spans WHERE span_id = ?')
        .bind(event.spanId)
        .first<any>();
      expect(inDb).not.toBeNull();
      expect(inDb.symbol).toBe('SOL/USDT');

      // Verify Grafana was invoked
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('MONITORING_SINK="d1": writes to D1 and skips Grafana calls', async () => {
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      const d1OnlyEnv = { ...env, MONITORING_SINK: 'd1' };
      const event = createMockEvent({ symbol: 'D1-ONLY/USDT' });
      const req = new Request('http://localhost/internal/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Ingest-Secret': 'test-ingest-secret',
        },
        body: JSON.stringify({
          batchId: 'batch-d1-only',
          producer: 'crypto-pulse-backend',
          producedAtMs: Date.now(),
          events: [event],
        }),
      });

      const res = await handleMonitorFetch(req, d1OnlyEnv);
      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json.outcome.inserted).toBe(1);
      expect(json.outcome.grafanaDelivered).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();

      // D1 verified
      const inDb = await db
        .prepare('SELECT span_id FROM stage_spans WHERE span_id = ?')
        .bind(event.spanId)
        .first<any>();
      expect(inDb).not.toBeNull();
    });

    it('MONITORING_SINK="grafana": delivers to Grafana and bypasses D1 writes to conserve quota', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = mockFetch;

      const grafanaOnlyEnv = { ...env, MONITORING_SINK: 'grafana' };
      const event = createMockEvent({ symbol: 'GRAFANA-ONLY/USDT' });
      const req = new Request('http://localhost/internal/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Ingest-Secret': 'test-ingest-secret',
        },
        body: JSON.stringify({
          batchId: 'batch-grafana-only',
          producer: 'crypto-pulse-backend',
          producedAtMs: Date.now(),
          events: [event],
        }),
      });

      const res = await handleMonitorFetch(req, grafanaOnlyEnv);
      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json.outcome.sinkMode).toBe('grafana');
      expect(json.outcome.grafanaDelivered).toBe(1);

      // Verify D1 write was bypassed
      const inDb = await db
        .prepare('SELECT span_id FROM stage_spans WHERE span_id = ?')
        .bind(event.spanId)
        .first<any>();
      expect(inDb).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('Fail-open protection: if Grafana network fails, D1 write still commits and HTTP 200 is returned', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Grafana Cloud Gateway down'));

      const event = createMockEvent({ symbol: 'FAIL-OPEN/USDT' });
      const req = new Request('http://localhost/internal/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Ingest-Secret': 'test-ingest-secret',
        },
        body: JSON.stringify({
          batchId: 'batch-failopen',
          producer: 'trading-bot-do',
          producedAtMs: Date.now(),
          events: [event],
        }),
      });

      const res = await handleMonitorFetch(req, env);
      expect(res.status).toBe(200); // Must never fail the backend producer

      const inDb = await db
        .prepare('SELECT span_id FROM stage_spans WHERE span_id = ?')
        .bind(event.spanId)
        .first<any>();
      expect(inDb).not.toBeNull(); // D1 successfully committed
    });

    it('supports ExecutionContext.waitUntil() without blocking the HTTP response', async () => {
      let waitUntilPromise: Promise<any> | null = null;
      const mockCtx = {
        waitUntil(promise: Promise<any>) {
          waitUntilPromise = promise;
        },
        passThroughOnException() {},
      } as unknown as ExecutionContext;

      globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

      const event = createMockEvent({ symbol: 'WAITUNTIL/USDT' });
      const req = new Request('http://localhost/internal/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Ingest-Secret': 'test-ingest-secret',
        },
        body: JSON.stringify({
          batchId: 'batch-waituntil',
          producer: 'trading-bot-do',
          producedAtMs: Date.now(),
          events: [event],
        }),
      });

      const res = await handleMonitorFetch(req, env, mockCtx);
      expect(res.status).toBe(200);
      expect(waitUntilPromise).not.toBeNull();

      // Wait until promise finishes
      await waitUntilPromise;
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
