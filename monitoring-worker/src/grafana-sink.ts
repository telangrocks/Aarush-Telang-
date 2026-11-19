import {
  PipelineTelemetryEvent,
  SpanSeverity,
  TelemetryQueueEnvelope,
  scrubSensitiveString,
} from '../../shared/monitoring';
import { MonitoringEnv } from './types';

export interface GrafanaDeliveryResult {
  ok: boolean;
  delivered: number;
  failed: number;
  durationMs: number;
  skipped?: boolean;
  statusCode?: number;
  error?: string;
}

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: OtlpAnyValue;
  attributes: OtlpKeyValue[];
  traceId?: string;
  spanId?: string;
}

export interface OtlpScopeLogs {
  scope: {
    name: string;
    version: string;
  };
  logRecords: OtlpLogRecord[];
}

export interface OtlpResourceLogs {
  resource: {
    attributes: OtlpKeyValue[];
  };
  scopeLogs: OtlpScopeLogs[];
}

export interface OtlpLogsPayload {
  resourceLogs: OtlpResourceLogs[];
}

/**
 * Maps CryptoPulse SpanSeverity to standard OpenTelemetry log severity number (1..24).
 * DEBUG: 5, INFO: 9, WARN/WARNING: 13, ERROR: 17, CRITICAL: 21
 */
export function severityToOtlpSeverityNumber(severity?: SpanSeverity | string): number {
  switch (severity?.toUpperCase()) {
    case 'DEBUG':
      return 5;
    case 'INFO':
      return 9;
    case 'WARN':
    case 'WARNING':
      return 13;
    case 'ERROR':
      return 17;
    case 'CRITICAL':
    case 'FATAL':
      return 21;
    default:
      return 9;
  }
}

/**
 * Resolves the target OTLP/HTTP Logs endpoint from the user/environment input.
 * Supports base URLs, /otlp suffix, or direct /otlp/v1/logs.
 */
export function resolveGrafanaLogsEndpoint(endpoint?: string): string | null {
  if (!endpoint || typeof endpoint !== 'string') return null;
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  if (!trimmed) return null;

  if (trimmed.endsWith('/v1/logs')) {
    return trimmed;
  }
  if (trimmed.endsWith('/otlp')) {
    return `${trimmed}/v1/logs`;
  }
  return `${trimmed}/otlp/v1/logs`;
}

/**
 * Builds HTTP Authorization header for Grafana Cloud OTLP Gateway.
 * Grafana Cloud requires HTTP Basic Auth: base64(instance_id:api_token).
 * Also accepts direct Bearer or Basic string if passed directly in GRAFANA_API_TOKEN.
 */
export function buildGrafanaAuthHeader(env: MonitoringEnv): string | null {
  const token = (env.GRAFANA_API_TOKEN || '').trim();
  const instanceId = (env.GRAFANA_INSTANCE_ID || '').trim();

  if (token.startsWith('Basic ') || token.startsWith('Bearer ')) {
    return token;
  }

  if (instanceId && token) {
    // Cloudflare Workers Web standard base64 encoding
    const encoded = typeof btoa === 'function'
      ? btoa(`${instanceId}:${token}`)
      : Buffer.from(`${instanceId}:${token}`).toString('base64');
    return `Basic ${encoded}`;
  }

  if (token) {
    return `Bearer ${token}`;
  }

  return null;
}

function stringAttribute(key: string, val: unknown): OtlpKeyValue | null {
  if (val === undefined || val === null) return null;
  const str = String(val).trim();
  if (!str) return null;
  return {
    key,
    value: { stringValue: scrubSensitiveString(str).slice(0, 500) },
  };
}

function intAttribute(key: string, val: unknown): OtlpKeyValue | null {
  if (typeof val !== 'number' || !Number.isInteger(val)) return null;
  return {
    key,
    value: { intValue: val.toString() },
  };
}

function doubleAttribute(key: string, val: unknown): OtlpKeyValue | null {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  return {
    key,
    value: { doubleValue: val },
  };
}

/**
 * Transforms an envelope of CryptoPulse PipelineTelemetryEvents into the standard
 * OpenTelemetry OTLP/HTTP JSON Logs format.
 */
export function buildOtlpLogsPayload(
  events: PipelineTelemetryEvent[],
  env: MonitoringEnv,
  producer?: string
): OtlpLogsPayload {
  const environment = env.ENVIRONMENT || 'demo';
  const observedTimeNano = (Date.now() * 1_000_000).toString();

  const resourceAttributes: OtlpKeyValue[] = [
    { key: 'service.name', value: { stringValue: 'cryptopulse-backend' } },
    { key: 'service.namespace', value: { stringValue: 'cryptopulse' } },
    { key: 'deployment.environment', value: { stringValue: environment } },
  ];
  if (producer) {
    resourceAttributes.push({
      key: 'service.instance.id',
      value: { stringValue: scrubSensitiveString(producer) },
    });
  }

  const logRecords: OtlpLogRecord[] = events.map((ev) => {
    const emittedNano = ((ev.emittedAtMs || Date.now()) * 1_000_000).toString();
    const severityText = ev.severity || 'INFO';
    const severityNumber = severityToOtlpSeverityNumber(severityText);

    const attributes: OtlpKeyValue[] = [];

    const addStr = (k: string, v: unknown) => {
      const a = stringAttribute(k, v);
      if (a) attributes.push(a);
    };
    const addInt = (k: string, v: unknown) => {
      const a = intAttribute(k, v);
      if (a) attributes.push(a);
    };
    const addDbl = (k: string, v: unknown) => {
      const a = doubleAttribute(k, v);
      if (a) attributes.push(a);
    };

    addStr('event.type', ev.eventType);
    addInt('stage', ev.stage);
    addStr('journey', ev.journey);
    addStr('status', ev.status);
    addStr('tier', ev.tier);
    addStr('component', ev.component);
    addStr('span.id', ev.spanId);
    addStr('span.group_id', ev.spanGroupId);
    addInt('stage_seq', ev.stageSeq);
    addStr('environment', ev.environment);

    addStr('symbol', ev.symbol);
    addStr('timeframe', ev.timeframe);
    addStr('strategy_id', ev.strategyId);
    addStr('cycle_id', ev.cycleId);
    addStr('trace_id', ev.traceId);
    addStr('user_id', ev.userId);
    addStr('bot_id', ev.botId);
    addStr('discovery_cycle_id', ev.discoveryCycleId);
    addStr('alert_id', ev.alertId);
    addStr('intent_id', ev.intentId);
    addStr('client_order_id', ev.clientOrderId);
    addStr('order_id', ev.orderId);
    addStr('fcm_message_id', ev.fcmMessageId);
    addStr('android_device_session_hash', ev.androidDeviceSessionHash);
    addStr('delivery_milestone', ev.deliveryMilestone);
    addStr('error_code', ev.errorCode);
    addStr('source_file', ev.sourceFile);
    addDbl('duration_ms', ev.durationMs);

    if (ev.inputSummary && typeof ev.inputSummary === 'object') {
      addStr('input_summary', JSON.stringify(ev.inputSummary));
    }
    if (ev.outputSummary && typeof ev.outputSummary === 'object') {
      addStr('output_summary', JSON.stringify(ev.outputSummary));
    }
    if (ev.metadata && typeof ev.metadata === 'object') {
      addStr('metadata', JSON.stringify(ev.metadata));
    }

    const logRecord: OtlpLogRecord = {
      timeUnixNano: emittedNano,
      observedTimeUnixNano: observedTimeNano,
      severityNumber,
      severityText,
      body: {
        stringValue: scrubSensitiveString(ev.message || `Stage ${ev.stage} ${ev.eventType} [${ev.status}]`),
      },
      attributes,
    };

    if (ev.traceId && /^[0-9a-fA-F]{32}$/.test(ev.traceId)) {
      logRecord.traceId = ev.traceId;
    }
    if (ev.spanId && /^[0-9a-fA-F]{16}$/.test(ev.spanId)) {
      logRecord.spanId = ev.spanId;
    }

    return logRecord;
  });

  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [
          {
            scope: {
              name: 'cryptopulse.monitoring.pipeline',
              version: '2.0.0',
            },
            logRecords,
          },
        ],
      },
    ],
  };
}

/**
 * Forwards a telemetry envelope to Grafana Cloud OTLP Gateway using Cloudflare Workers-native fetch().
 * - Non-blocking fail-open execution.
 * - Enforces request timeout with AbortController.
 * - Single automatic retry on 5xx server errors or transient network failures.
 */
export async function forwardToGrafana(
  envelope: TelemetryQueueEnvelope,
  env: MonitoringEnv,
  timeoutMs = 5000
): Promise<GrafanaDeliveryResult> {
  const startMs = Date.now();
  const rawEvents = Array.isArray(envelope?.events) ? envelope.events : [];
  if (rawEvents.length === 0) {
    return { ok: true, delivered: 0, failed: 0, durationMs: 0, skipped: true };
  }

  const endpoint = resolveGrafanaLogsEndpoint(env.GRAFANA_OTLP_ENDPOINT);
  const authHeader = buildGrafanaAuthHeader(env);

  if (!endpoint || !authHeader) {
    // Graceful skip: Grafana credentials are not configured in this environment
    return {
      ok: true,
      delivered: 0,
      failed: 0,
      durationMs: Date.now() - startMs,
      skipped: true,
      error: !endpoint ? 'GRAFANA_OTLP_ENDPOINT not configured' : 'GRAFANA auth credentials not configured',
    };
  }

  const payload = buildOtlpLogsPayload(rawEvents, env, envelope.producer);
  const bodyString = JSON.stringify(payload);

  const sendOnce = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'User-Agent': 'CryptoPulse-Monitoring-Worker/2.0',
        },
        body: bodyString,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let response: Response;
    try {
      response = await sendOnce();
    } catch (initialErr: any) {
      // First attempt failed; retry once if aborted or transient error
      await new Promise((res) => setTimeout(res, 250));
      response = await sendOnce();
    }

    // 200 OK, 202 Accepted, or 204 No Content are valid OTLP ingestion responses
    if (response.status === 200 || response.status === 202 || response.status === 204) {
      return {
        ok: true,
        delivered: rawEvents.length,
        failed: 0,
        durationMs: Date.now() - startMs,
        statusCode: response.status,
      };
    }

    // Retry once on 5xx or 429
    if (response.status >= 500 || response.status === 429) {
      await new Promise((res) => setTimeout(res, 250));
      const retryResponse = await sendOnce();
      if (retryResponse.status === 200 || retryResponse.status === 202 || retryResponse.status === 204) {
        return {
          ok: true,
          delivered: rawEvents.length,
          failed: 0,
          durationMs: Date.now() - startMs,
          statusCode: retryResponse.status,
        };
      }
      const errText = await retryResponse.text().catch(() => '');
      return {
        ok: false,
        delivered: 0,
        failed: rawEvents.length,
        durationMs: Date.now() - startMs,
        statusCode: retryResponse.status,
        error: `Grafana OTLP HTTP ${retryResponse.status}: ${errText.slice(0, 200)}`,
      };
    }

    const errText = await response.text().catch(() => '');
    return {
      ok: false,
      delivered: 0,
      failed: rawEvents.length,
      durationMs: Date.now() - startMs,
      statusCode: response.status,
      error: `Grafana OTLP HTTP ${response.status}: ${errText.slice(0, 200)}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      delivered: 0,
      failed: rawEvents.length,
      durationMs: Date.now() - startMs,
      error: scrubSensitiveString(err?.message || 'Network error').slice(0, 200),
    };
  }
}
