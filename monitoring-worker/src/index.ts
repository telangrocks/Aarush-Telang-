import {
  PipelineTelemetryEvent,
  TelemetryQueueEnvelope,
  generateSpanId,
  normalizeEnvironmentMode,
  scrubSensitiveString,
} from '../../shared/monitoring';
import { authenticateReadOnlyAdmin, buildCorsHeaders, timingSafeEqualAscii } from './auth';
import { handleDlqBatch, handleQueueBatch, ingestEnvelope, pruneExpiredTelemetry } from './consumer';
import { handleMonitorQueryV2 } from './query-api';
import { MonitoringEnv, TelemetryQueueBatch } from './types';

/** Queue-free Free-plan delivery mode (best-effort, bounded, not durable). */
export const TELEMETRY_DELIVERY_MODE = 'BEST_EFFORT_SERVICE_BINDING_WAITUNTIL';
const MAX_INGEST_BODY_BYTES = 256 * 1024;
const MAX_INGEST_EVENTS_PER_BATCH = 100;

function jsonResponse(
  data: unknown,
  status: number,
  corsHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

function buildTailCrashEvents(items: TraceItem[], env: MonitoringEnv): PipelineTelemetryEvent[] {
  const events: PipelineTelemetryEvent[] = [];
  const environment = normalizeEnvironmentMode(env.ENVIRONMENT);

  for (const item of items) {
    const hasCrashOutcome = item.outcome && item.outcome !== 'ok';
    const hasExceptions = Array.isArray(item.exceptions) && item.exceptions.length > 0;
    if (!hasCrashOutcome && !hasExceptions) continue;

    const firstEx = hasExceptions ? item.exceptions[0] : undefined;
    const rawMsg = firstEx
      ? `${firstEx.name || 'Error'}: ${firstEx.message || item.outcome}`
      : `Worker outcome ${item.outcome}`;

    events.push({
      schemaVersion: 2,
      spanId: generateSpanId('tail'),
      journey: 'SYSTEM',
      stage: 1,
      tier: 'TIER_1',
      eventType: 'TAIL_UNHANDLED_EXCEPTION',
      status: 'FAIL',
      severity: 'CRITICAL',
      environment,
      stageSeq: 1,
      emittedAtMs: item.eventTimestamp || Date.now(),
      durationMs: typeof item.wallTime === 'number' ? item.wallTime : undefined,
      deliveryMilestone: 'EVENT_CREATED',
      component: scrubSensitiveString(item.scriptName || 'TailWorker').slice(0, 64),
      errorCode: scrubSensitiveString(String(item.outcome || 'EXCEPTION')).slice(0, 64),
      message: scrubSensitiveString(rawMsg).slice(0, 480),
      outputSummary: {
        outcome: item.outcome,
        executionModel: item.executionModel,
        cpuTimeMs: item.cpuTime,
        wallTimeMs: item.wallTime,
        exceptionCount: item.exceptions?.length ?? 0,
      },
    });
  }

  return events;
}

export async function handleMonitorFetch(request: Request, env: MonitoringEnv): Promise<Response> {
  const url = new URL(request.url);
  const corsHeaders = buildCorsHeaders(request, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (url.pathname === '/health') {
    return jsonResponse(
      {
        ok: true,
        service: 'cryptopulse-monitoring-worker',
        readOnly: true,
        environment: env.ENVIRONMENT || null,
        deliveryMode: TELEMETRY_DELIVERY_MODE,
        queueStatus: 'NOT_APPLICABLE',
        durableDelivery: false,
        timestampMs: Date.now(),
      },
      200,
      corsHeaders
    );
  }

  // Queue-free (Cloudflare Free plan) best-effort ingest via Worker-to-Worker Service Binding
  if (url.pathname === '/internal/ingest' && request.method === 'POST') {
    if (request.headers.get('Origin')) {
      return jsonResponse({ error: 'Forbidden' }, 403, corsHeaders);
    }
    if (env.REQUIRE_INTERNAL_SECRET === 'true') {
      // Fail closed: when the secret is required but not configured, reject rather than accept anonymous writes.
      if (!env.INTERNAL_INGEST_SECRET) {
        return jsonResponse({ error: 'Ingest secret not configured' }, 503, corsHeaders);
      }
      const provided = request.headers.get('X-Internal-Ingest-Secret') || '';
      if (!timingSafeEqualAscii(provided, env.INTERNAL_INGEST_SECRET)) {
        return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
      }
    }

    const declaredLength = Number(request.headers.get('Content-Length') || '0');
    if (declaredLength > MAX_INGEST_BODY_BYTES) {
      return jsonResponse({ error: 'Payload Too Large' }, 413, corsHeaders);
    }

    try {
      const raw = await request.text();
      if (raw.length > MAX_INGEST_BODY_BYTES) {
        return jsonResponse({ error: 'Payload Too Large' }, 413, corsHeaders);
      }
      const envelope = JSON.parse(raw) as TelemetryQueueEnvelope;
      if (!envelope || !Array.isArray(envelope.events)) {
        return jsonResponse({ error: 'Invalid telemetry envelope' }, 400, corsHeaders);
      }
      if (envelope.events.length > MAX_INGEST_EVENTS_PER_BATCH) {
        return jsonResponse({ error: 'Too many events in batch' }, 413, corsHeaders);
      }
      const outcome = await ingestEnvelope(env.MONITORING_DB, envelope);
      return jsonResponse({ ok: true, deliveryMode: TELEMETRY_DELIVERY_MODE, outcome }, 200, corsHeaders);
    } catch (err: any) {
      return jsonResponse({ ok: false, error: scrubSensitiveString(err?.message || 'ingest_error').slice(0, 200) }, 500, corsHeaders);
    }
  }

  if (url.pathname.startsWith('/api/monitor/v2/')) {
    // Hard read-only boundary enforcement
    if (request.method !== 'GET') {
      return jsonResponse(
        { error: 'Method Not Allowed: monitoring API is strictly read-only' },
        405,
        corsHeaders
      );
    }

    const auth = await authenticateReadOnlyAdmin(request, env);
    if (!auth.ok) {
      return jsonResponse({ error: auth.error }, auth.status, corsHeaders);
    }

    const queryRes = await handleMonitorQueryV2(request, url, env, auth.principal);
    if (queryRes) {
      return jsonResponse(queryRes.body, queryRes.status, corsHeaders);
    }

    return jsonResponse({ error: 'Not Found' }, 404, corsHeaders);
  }

  return jsonResponse({ error: 'Not Found' }, 404, corsHeaders);
}

export default {
  async fetch(request: Request, env: MonitoringEnv, _ctx: ExecutionContext): Promise<Response> {
    return handleMonitorFetch(request, env);
  },

  async queue(batch: TelemetryQueueBatch, env: MonitoringEnv): Promise<void> {
    if (batch.queue && batch.queue.includes('dlq')) {
      await handleDlqBatch(batch, env);
      return;
    }
    await handleQueueBatch(batch, env);
  },

  async scheduled(_controller: ScheduledController, env: MonitoringEnv): Promise<void> {
    await pruneExpiredTelemetry(env.MONITORING_DB, Date.now());
  },

  async tail(events: TraceItem[], env: MonitoringEnv): Promise<void> {
    const crashEvents = buildTailCrashEvents(events, env);
    if (crashEvents.length === 0) return;

    const envelope: TelemetryQueueEnvelope = {
      batchId: generateSpanId('tailbat'),
      producer: 'tail-worker',
      producedAtMs: Date.now(),
      events: crashEvents,
    };

    try {
      await ingestEnvelope(env.MONITORING_DB, envelope);
    } catch {
      // Fail-open on tail worker crash capture
    }
  },
};
