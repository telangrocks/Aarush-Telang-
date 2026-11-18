import {
  PipelineTelemetryEvent,
  TelemetryQueueEnvelope,
  generateSpanId,
  normalizeEnvironmentMode,
  scrubSensitiveString,
} from '../../shared/monitoring';
import { authenticateReadOnlyAdmin, buildCorsHeaders, timingSafeEqualAscii } from './auth';
import { handleDlqBatch, handleQueueBatch, ingestEnvelope, pruneExpiredTelemetry } from './consumer';
import { forwardToGrafana } from './grafana-sink';
import { handleMonitorQueryV2 } from './query-api';
import { MonitoringEnv, TelemetryQueueBatch } from './types';

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

export async function handleMonitorFetch(
  request: Request,
  env: MonitoringEnv,
  ctx?: ExecutionContext
): Promise<Response> {
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
        sinkMode: env.MONITORING_SINK || 'both',
        hasGrafana: Boolean(env.GRAFANA_OTLP_ENDPOINT),
        timestampMs: Date.now(),
      },
      200,
      corsHeaders
    );
  }

  // Worker-to-Worker Service Binding HTTP fallback ingest
  if (url.pathname === '/internal/ingest' && request.method === 'POST') {
    if (request.headers.get('Origin')) {
      return jsonResponse({ error: 'Forbidden' }, 403, corsHeaders);
    }
    if (env.REQUIRE_INTERNAL_SECRET === 'true' && env.INTERNAL_INGEST_SECRET) {
      const provided = request.headers.get('X-Internal-Ingest-Secret') || '';
      if (!timingSafeEqualAscii(provided, env.INTERNAL_INGEST_SECRET)) {
        return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
      }
    }

    try {
      const envelope = (await request.json()) as TelemetryQueueEnvelope;
      if (!envelope || !Array.isArray(envelope.events)) {
        return jsonResponse({ error: 'Invalid telemetry envelope' }, 400, corsHeaders);
      }

      const outcome = await ingestEnvelope(env.MONITORING_DB, envelope, env);

      // Grafana Cloud OTLP dual-sink forwarding
      const sinkMode = (env.MONITORING_SINK || 'both').toLowerCase();
      if (sinkMode === 'both' || sinkMode === 'grafana') {
        const grafanaPromise = forwardToGrafana(envelope, env).catch(() => ({
          ok: false,
          delivered: 0,
          failed: envelope.events?.length || 0,
          durationMs: 0,
        }));

        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(grafanaPromise);
        } else {
          const gRes = await grafanaPromise;
          if (gRes) {
            outcome.grafanaDelivered = gRes.delivered;
            outcome.grafanaFailed = gRes.failed;
            outcome.grafanaDurationMs = gRes.durationMs;
          }
        }
      }

      return jsonResponse({ ok: true, outcome }, 200, corsHeaders);
    } catch (err: any) {
      return jsonResponse({ ok: false, error: err?.message || 'ingest_error' }, 500, corsHeaders);
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
  async fetch(request: Request, env: MonitoringEnv, ctx: ExecutionContext): Promise<Response> {
    return handleMonitorFetch(request, env, ctx);
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
