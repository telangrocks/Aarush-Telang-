/**
 * admin-monitoring.ts
 *
 * Route handlers for the CryptoPulse Admin Centralized Monitoring Platform.
 *
 * Invariants:
 * - Strictly guarded by adminAuthMiddleware.
 * - All responses are sanitized (zero user passwords, secrets, or decrypted exchange keys).
 * - Bounded query windows and pagination protect D1 IOPS and memory.
 */

import { Context } from 'hono';
import { Env } from '../index';
import { MonitoringService } from '../infrastructure/monitoring/MonitoringService';
import { RootCauseEngine } from '../infrastructure/monitoring/RootCauseEngine';
import {
  MonitoringSeverity,
  IncidentStatus,
  validateMonitoringEvent
} from '../infrastructure/monitoring/MonitoringEvent';
import { createScopedTelemetryEmitter } from '../infrastructure/monitoring/PipelineTelemetry';
import { PipelineTelemetryEvent, normalizeEnvironmentMode } from '../../../shared/monitoring';

/**
 * GET /api/admin/monitoring/overview
 * Centralized KPI summary of users, bot fleet, incidents, and quotas.
 */
export async function handleGetFleetOverview(c: Context<{ Bindings: Env }>) {
  try {
    const monitoring = MonitoringService.getInstance();
    const healthStats = monitoring.getHealthStats();

    let totalUsers = 0;
    let activeUsers24h = 0;
    let activePositionsCount = 0;

    const now = Date.now();
    const dayAgoSec = Math.floor((now - 24 * 3600 * 1000) / 1000);

    if (c.env.DB) {
      try {
        const uTotal = await c.env.DB.prepare('SELECT COUNT(*) as c FROM users').first<{ c: number }>();
        totalUsers = uTotal?.c ?? 0;

        const uActive = await c.env.DB.prepare(
          'SELECT COUNT(DISTINCT user_id) as c FROM audit_log WHERE timestamp >= ?'
        )
          .bind(dayAgoSec * 1000)
          .first<{ c: number }>();
        activeUsers24h = uActive?.c ?? 0;

        const pActive = await c.env.DB.prepare(
          "SELECT COUNT(*) as c FROM trade_positions WHERE status = 'OPEN'"
        ).first<{ c: number }>();
        activePositionsCount = pActive?.c ?? 0;
      } catch (err) {
        console.warn('[AdminMonitoring] D1 overview query error:', err);
      }
    }

    // Incidents in last 24h
    const recent24hIncidents = await monitoring.queryIncidents(c.env.DB, {
      since: now - 24 * 3600 * 1000,
      limit: 100
    });

    const unresolvedCount = recent24hIncidents.items.filter((i) => i.status === 'UNRESOLVED').length;
    const criticalCount = recent24hIncidents.items.filter((i) => i.severity === 'CRITICAL').length;
    const errorCount = recent24hIncidents.items.filter((i) => i.severity === 'ERROR').length;

    return c.json({
      timestamp: now,
      systemStatus: criticalCount > 0 ? 'DEGRADED' : unresolvedCount > 10 ? 'WARNING' : 'OPERATIONAL',
      fleet: {
        totalRegisteredUsers: totalUsers,
        activeUsers24h,
        openPositionsCount: activePositionsCount
      },
      incidents24h: {
        total: recent24hIncidents.total,
        unresolved: unresolvedCount,
        critical: criticalCount,
        error: errorCount
      },
      monitoringHealth: healthStats
    });
  } catch (err: any) {
    console.error('[AdminMonitoring] handleGetFleetOverview error:', err);
    return c.json({ error: 'Internal Error', message: err?.message || 'Failed to load overview' }, 500);
  }
}

/**
 * GET /api/admin/monitoring/users
 * Paginated list of registered users (sanitized: NO credentials or secrets).
 */
export async function handleGetUsersList(c: Context<{ Bindings: Env }>) {
  try {
    const page = Math.max(Number(c.req.query('page')) || 1, 1);
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 25, 1), 50);
    const search = c.req.query('search')?.trim();
    const offset = (page - 1) * limit;

    if (!c.env.DB) {
      return c.json({ items: [], total: 0, page, limit, message: 'Database unavailable' });
    }

    let countSql = 'SELECT COUNT(*) as total FROM users';
    let querySql = `
      SELECT id, email, status, exchange_name, exchange_environment, exchange_region,
             exchange_connection_status, created_at,
             (exchange_api_key_encrypted IS NOT NULL) as has_api_key
      FROM users
    `;

    const bindings: unknown[] = [];
    if (search) {
      countSql += ' WHERE email LIKE ?';
      querySql += ' WHERE email LIKE ?';
      bindings.push(`%${search}%`);
    }

    querySql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

    const countRes = await c.env.DB.prepare(countSql).bind(...bindings).first<{ total: number }>();
    const total = countRes?.total ?? 0;

    const rows = await c.env.DB.prepare(querySql).bind(...bindings, limit, offset).all<any>();

    const items = (rows.results || []).map((u: any) => ({
      id: u.id,
      email: u.email,
      status: u.status || 'ACTIVE',
      exchangeName: u.exchange_name || 'NONE',
      exchangeEnvironment: u.exchange_environment || 'demo',
      exchangeRegion: u.exchange_region || 'aws-eu-central-1',
      exchangeConnectionStatus: u.exchange_connection_status || 'DISCONNECTED',
      hasApiKey: Boolean(u.has_api_key),
      createdAt: u.created_at
    }));

    return c.json({
      items,
      total,
      page,
      limit,
      hasMore: offset + limit < total
    });
  } catch (err: any) {
    console.error('[AdminMonitoring] handleGetUsersList error:', err);
    return c.json({ error: 'Internal Error', message: err?.message || 'Failed to list users' }, 500);
  }
}

/**
 * GET /api/admin/monitoring/bots
 * Paginated bot inventory across users with health classification.
 */
export async function handleGetBotFleet(c: Context<{ Bindings: Env }>) {
  try {
    const page = Math.max(Number(c.req.query('page')) || 1, 1);
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 25, 1), 50);
    const statusFilter = c.req.query('status')?.toUpperCase();
    const offset = (page - 1) * limit;

    if (!c.env.DB) {
      return c.json({ items: [], total: 0, page, limit });
    }

    // Query active bot setups and open positions from D1
    const sql = `
      SELECT u.id as user_id, u.email, u.exchange_name, u.exchange_environment,
             u.exchange_connection_status,
             p.id as position_id, p.symbol, p.side, p.strategy, p.status as position_status,
             p.entry_price, p.entry_at, p.updated_at
      FROM users u
      LEFT JOIN trade_positions p ON u.id = p.user_id AND p.status = 'OPEN'
      WHERE u.exchange_name IS NOT NULL
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const countRes = await c.env.DB.prepare(
      'SELECT COUNT(*) as total FROM users WHERE exchange_name IS NOT NULL'
    ).first<{ total: number }>();
    const total = countRes?.total ?? 0;

    const rows = await c.env.DB.prepare(sql).bind(limit, offset).all<any>();
    const now = Date.now();

    const items = (rows.results || []).map((r: any) => {
      const hasOpenPosition = Boolean(r.position_id);
      const isConnected = r.exchange_connection_status === 'CONNECTED';

      // Health state calculation:
      // HEALTHY: Connected exchange, valid status
      // ERROR: Connection failed
      // INACTIVE: No exchange configured or disconnected
      // STALE: Connected but no updates in > 10 min
      let botState: 'HEALTHY' | 'STALE' | 'INACTIVE' | 'ERROR' = 'INACTIVE';
      if (r.exchange_connection_status === 'FAILED') {
        botState = 'ERROR';
      } else if (isConnected) {
        botState = 'HEALTHY';
      }

      if (statusFilter && botState !== statusFilter) {
        return null;
      }

      return {
        botId: `bot_${r.user_id.slice(0, 8)}`,
        userId: r.user_id,
        userEmail: r.email,
        exchange: r.exchange_name,
        environment: r.exchange_environment || 'demo',
        connectionStatus: r.exchange_connection_status,
        botState,
        activePosition: hasOpenPosition
          ? {
              positionId: r.position_id,
              symbol: r.symbol,
              side: r.side,
              strategy: r.strategy,
              entryPrice: r.entry_price,
              entryAt: r.entry_at
            }
          : null,
        lastObservedAt: r.updated_at || r.entry_at || now
      };
    }).filter(Boolean);

    return c.json({
      items,
      total,
      page,
      limit,
      hasMore: offset + limit < total
    });
  } catch (err: any) {
    console.error('[AdminMonitoring] handleGetBotFleet error:', err);
    return c.json({ error: 'Internal Error', message: err?.message || 'Failed to list bot fleet' }, 500);
  }
}

/**
 * GET /api/admin/monitoring/incidents
 * Paginated filterable query of system incidents.
 */
export async function handleGetIncidents(c: Context<{ Bindings: Env }>) {
  try {
    const monitoring = MonitoringService.getInstance();
    const severity = c.req.query('severity')?.toUpperCase() as MonitoringSeverity | undefined;
    const source = c.req.query('source')?.toUpperCase();
    const component = c.req.query('component');
    const status = c.req.query('status')?.toUpperCase() as IncidentStatus | undefined;
    const userId = c.req.query('userId');
    const correlationId = c.req.query('correlationId');
    const search = c.req.query('search');
    const page = Number(c.req.query('page')) || 1;
    const limit = Number(c.req.query('limit')) || 25;

    const result = await monitoring.queryIncidents(c.env.DB, {
      severity,
      source,
      component,
      status,
      userId,
      correlationId,
      search,
      page,
      limit
    });

    return c.json(result);
  } catch (err: any) {
    console.error('[AdminMonitoring] handleGetIncidents error:', err);
    return c.json({ error: 'Internal Error', message: err?.message || 'Failed to query incidents' }, 500);
  }
}

/**
 * GET /api/admin/monitoring/incidents/:id
 * Single incident detail with evidence, deterministic root cause, and Antigravity prompt.
 */
export async function handleGetIncidentDetail(c: Context<{ Bindings: Env }>) {
  try {
    const id = c.req.param('id');
    if (!id) {
      return c.json({ error: 'Bad Request', message: 'Incident ID is required.' }, 400);
    }
    const monitoring = MonitoringService.getInstance();

    const incident = await monitoring.getIncidentById(c.env.DB, id);
    if (!incident) {
      return c.json({ error: 'Not Found', message: `Incident with ID '${id}' was not found.` }, 404);
    }

    const diagnosis = RootCauseEngine.diagnoseIncident(incident);

    return c.json({
      incident,
      diagnosis
    });
  } catch (err: any) {
    console.error('[AdminMonitoring] handleGetIncidentDetail error:', err);
    return c.json({ error: 'Internal Error', message: err?.message || 'Failed to load incident detail' }, 500);
  }
}

/**
 * PATCH /api/admin/monitoring/incidents/:id/status
 * Updates resolution status of an incident (RESOLVED, INVESTIGATING, IGNORED).
 */
export async function handleUpdateIncidentStatus(c: Context<{ Bindings: Env }>) {
  try {
    const id = c.req.param('id');
    if (!id) {
      return c.json({ error: 'Bad Request', message: 'Incident ID is required.' }, 400);
    }
    const body = await c.req.json<{ status: IncidentStatus; notes?: string }>();

    if (!['UNRESOLVED', 'INVESTIGATING', 'RESOLVED', 'IGNORED'].includes(body.status)) {
      return c.json({ error: 'Bad Request', message: `Invalid status '${body.status}'.` }, 400);
    }

    const adminSession = (c as any).get('adminSession');
    const adminEmail = adminSession?.email || 'admin@cryptopulse.internal';

    const monitoring = MonitoringService.getInstance();
    const success = await monitoring.updateIncidentStatus(c.env.DB, id, body.status, adminEmail, body.notes);

    if (!success) {
      return c.json({ error: 'Not Found', message: `Incident '${id}' could not be updated.` }, 404);
    }

    return c.json({ success: true, id, status: body.status, updatedBy: adminEmail });
  } catch (err: any) {
    console.error('[AdminMonitoring] handleUpdateIncidentStatus error:', err);
    return c.json({ error: 'Internal Error', message: err?.message || 'Failed to update incident' }, 500);
  }
}

/**
 * GET /api/admin/monitoring/timeline
 * Chronological bot lifecycle events matching a correlationId, cycleId, or userId.
 */
export async function handleGetBotTimeline(c: Context<{ Bindings: Env }>) {
  try {
    const correlationId = c.req.query('correlationId');
    const cycleId = c.req.query('cycleId');
    const userId = c.req.query('userId');

    if (!correlationId && !cycleId && !userId) {
      return c.json(
        { error: 'Bad Request', message: 'Provide correlationId, cycleId, or userId to query timeline.' },
        400
      );
    }

    const monitoring = MonitoringService.getInstance();
    const result = await monitoring.queryIncidents(c.env.DB, {
      correlationId: correlationId || cycleId,
      userId,
      limit: 50
    });

    return c.json({
      correlationId: correlationId || cycleId,
      userId,
      events: result.items
    });
  } catch (err: any) {
    console.error('[AdminMonitoring] handleGetBotTimeline error:', err);
    return c.json({ error: 'Internal Error', message: err?.message || 'Failed to load timeline' }, 500);
  }
}

/**
 * GET /api/admin/monitoring/health
 * Edge component health (D1 database, coordinator stats, memory).
 */
export async function handleGetComponentHealth(c: Context<{ Bindings: Env }>) {
  try {
    let d1Status: 'CONNECTED' | 'ERROR' | 'UNBOUND' = 'UNBOUND';
    let d1LatencyMs = -1;

    if (c.env.DB) {
      const start = Date.now();
      try {
        await c.env.DB.prepare('SELECT 1').first();
        d1LatencyMs = Date.now() - start;
        d1Status = 'CONNECTED';
      } catch (err) {
        d1Status = 'ERROR';
      }
    }

    let coordinatorStats: any = null;
    if (c.env.PUBLIC_MARKET_COORDINATOR) {
      try {
        const coordId = c.env.PUBLIC_MARKET_COORDINATOR.idFromName('bybit:mainnet:aws-eu-central-1');
        const coordStub = c.env.PUBLIC_MARKET_COORDINATOR.get(coordId);
        const res = await coordStub.fetch('http://coordinator/stats');
        if (res.ok) {
          coordinatorStats = await res.json();
        }
      } catch (_) {}
    }

    const adminSession = (c.get as any)?.('adminSession');
    const isOperator = !adminSession || adminSession.monitoringScope === 'OPERATOR';
    const requestedProbeUserId = c.req.query('userId')?.trim();
    if (!isOperator && requestedProbeUserId && adminSession.userId && requestedProbeUserId !== adminSession.userId) {
      return c.json({ error: 'Forbidden', message: 'Cross-user health probe denied' }, 403);
    }
    const probeUserId = isOperator ? requestedProbeUserId : adminSession.userId;

    let tradingBotState: any = null;
    if (probeUserId && c.env.TRADING_BOTS) {
      try {
        const botId = c.env.TRADING_BOTS.idFromName(probeUserId);
        const botStub = c.env.TRADING_BOTS.get(botId);
        const res = await botStub.fetch('http://do/internal/monitor-state', { method: 'GET' });
        if (res.ok) {
          tradingBotState = await res.json();
        }
      } catch (_) {}
    }

    return c.json({
      timestamp: Date.now(),
      worker: {
        environment: c.env.ENVIRONMENT || 'production',
        signalManagerMode: c.env.SIGNAL_MANAGER_MODE || 'SHADOW'
      },
      d1Database: {
        status: d1Status,
        latencyMs: d1LatencyMs
      },
      publicMarketCoordinator: isOperator ? (coordinatorStats || { status: 'STANDBY' }) : null,
      tradingBotState
    });
  } catch (err: any) {
    console.error('[AdminMonitoring] handleGetComponentHealth error:', err);
    return c.json({ error: 'Internal Error', message: err?.message || 'Failed to check health' }, 500);
  }
}

/**
 * GET /api/admin/monitoring/quotas
 * Monitoring ingestion status and quota metrics.
 */
export async function handleGetQuotaStatus(c: Context<{ Bindings: Env }>) {
  const monitoring = MonitoringService.getInstance();
  const stats = monitoring.getHealthStats();

  return c.json({
    timestamp: Date.now(),
    quotas: stats
  });
}

/**
 * In-memory client telemetry rate limiter (max 30 events per 5 minutes per user).
 */
const clientTelemetryRateLimit = new Map<string, { count: number; windowStart: number }>();
const CLIENT_TELEMETRY_WINDOW_MS = 5 * 60 * 1000;
const CLIENT_TELEMETRY_MAX_PER_WINDOW = 30;

export function resetClientTelemetryLimiterForTesting(): void {
  clientTelemetryRateLimit.clear();
}

const STAGE9_MAX_BODY_BYTES = 32768;
const STAGE9_MAX_EVENTS_PER_BATCH = 25;

function isStage9TelemetryPayload(body: unknown): boolean {
  if (Array.isArray(body)) return true;
  if (!body || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return Array.isArray(obj.events) || obj.schemaVersion === 2 || obj.stage === 9;
}

function getSafeWaitUntil(c: Context<{ Bindings: Env }>): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    if (ctx && typeof ctx.waitUntil === 'function') {
      return (p: Promise<unknown>) => ctx.waitUntil(p);
    }
  } catch {
    // executionCtx throws in Hono when running outside Workers runtime / unit tests
  }
  return undefined;
}

/**
 * Diagnostic ingestion endpoint for Android clients and internal services.
 * - For mobile clients: Authenticated via standard User JWT (/api/client/telemetry).
 * - For administrators: Authenticated via AdminAuth middleware (/api/admin/monitoring/report-incident).
 */
export async function handleReportClientIncident(c: Context<{ Bindings: Env }>) {
  try {
    const rawBody = await c.req.json();
    const isStage9Batch = isStage9TelemetryPayload(rawBody);

    // 1. Strict payload size limit (max 4KB legacy incident, 32KB bounded Stage 9 batch)
    const rawString = JSON.stringify(rawBody);
    const maxBytes = isStage9Batch ? STAGE9_MAX_BODY_BYTES : 4096;
    if (rawString.length > maxBytes) {
      return c.json(
        {
          error: 'Payload Too Large',
          message: `Diagnostic payload exceeds ${isStage9Batch ? '32KB' : '4KB'} limit.`
        },
        413
      );
    }

    // 2. Identity Verification: Derive user ID from verified JWT session
    const jwtPayload = (c.get as any)('jwtPayload');
    const adminSession = (c.get as any)('adminSession');

    let verifiedUserId: string | undefined = undefined;
    let verifiedDeviceSessionHash: string | undefined = undefined;
    let isClientReport = false;

    if (jwtPayload?.sub) {
      // Authenticated regular user (e.g. Android app)
      verifiedUserId = String(jwtPayload.sub);
      if (typeof jwtPayload.androidDeviceSessionHash === 'string' && jwtPayload.androidDeviceSessionHash.trim()) {
        verifiedDeviceSessionHash = jwtPayload.androidDeviceSessionHash.trim().slice(0, 64);
      } else if (typeof jwtPayload.deviceSessionHash === 'string' && jwtPayload.deviceSessionHash.trim()) {
        verifiedDeviceSessionHash = jwtPayload.deviceSessionHash.trim().slice(0, 64);
      }
      isClientReport = true;
    } else if (adminSession?.role === 'ADMIN') {
      // Administrative or internal report
      const rawUserId =
        rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
          ? (rawBody as Record<string, unknown>).userId
          : undefined;
      verifiedUserId =
        adminSession.monitoringScope === 'OPERATOR' && rawUserId
          ? String(rawUserId)
          : adminSession.userId;
      if (typeof adminSession.deviceSessionHash === 'string' && adminSession.deviceSessionHash.trim()) {
        verifiedDeviceSessionHash = adminSession.deviceSessionHash.trim().slice(0, 64);
      }
    } else {
      return c.json({ error: 'Unauthorized', message: 'Authenticated user or administrative session required.' }, 401);
    }

    // 3. Rate limiting for client users (max 30 per 5 min)
    if (isClientReport && verifiedUserId) {
      const now = Date.now();
      const userLimitKey = `client_tel:${verifiedUserId}`;
      const record = clientTelemetryRateLimit.get(userLimitKey);

      if (!record || now - record.windowStart >= CLIENT_TELEMETRY_WINDOW_MS) {
        if (clientTelemetryRateLimit.size > 2000) {
          const oldest = clientTelemetryRateLimit.keys().next().value;
          if (oldest) clientTelemetryRateLimit.delete(oldest);
        }
        clientTelemetryRateLimit.set(userLimitKey, { count: 1, windowStart: now });
      } else {
        if (record.count >= CLIENT_TELEMETRY_MAX_PER_WINDOW) {
          return c.json(
            { error: 'Too Many Requests', message: 'Telemetry submission rate limit reached. Try again later.' },
            429
          );
        }
        record.count++;
      }
    }

    const derivedBotId = verifiedUserId ? `bot_${verifiedUserId.slice(0, 8)}` : undefined;

    if (isStage9Batch) {
      const items: unknown[] = Array.isArray(rawBody)
        ? rawBody
        : Array.isArray((rawBody as Record<string, unknown>).events)
          ? ((rawBody as Record<string, unknown>).events as unknown[])
          : [rawBody];

      if (items.length === 0 || items.length > STAGE9_MAX_EVENTS_PER_BATCH) {
        return c.json(
          {
            error: 'Bad Request',
            message: `Stage 9 telemetry batch must contain between 1 and ${STAGE9_MAX_EVENTS_PER_BATCH} events.`
          },
          400
        );
      }

      const emitter = createScopedTelemetryEmitter(
        isClientReport ? 'android-app' : 'crypto-pulse-backend',
        c.env
      );
      const acceptedIds: string[] = [];

      for (const rawItem of items) {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
          return c.json({ error: 'Bad Request', message: 'Each telemetry item must be an object.' }, 400);
        }
        const item = rawItem as Record<string, unknown>;
        const eventType =
          typeof item.eventType === 'string' && item.eventType.trim().length > 0
            ? item.eventType.trim().slice(0, 80)
            : 'ANDROID_STAGE9_EVENT';
        const component =
          typeof item.component === 'string' && item.component.trim().length > 0
            ? item.component.trim().slice(0, 80)
            : 'android-client';
        const message =
          typeof item.message === 'string' && item.message.trim().length > 0
            ? item.message.trim().slice(0, 500)
            : `Android Stage 9 ${eventType}`;
        const status =
          item.status === 'PASS' || item.status === 'WARN' || item.status === 'FAIL' || item.status === 'SKIPPED'
            ? item.status
            : 'PASS';
        const journey =
          item.journey === 'JOURNEY_A_DISCOVERY' ||
          item.journey === 'JOURNEY_B_AUTONOMOUS' ||
          item.journey === 'SYSTEM'
            ? item.journey
            : 'JOURNEY_B_AUTONOMOUS';
        const stage =
          typeof item.stage === 'number' && Number.isInteger(item.stage) && item.stage >= 1 && item.stage <= 9
            ? (item.stage as PipelineTelemetryEvent['stage'])
            : 9;

        const normalizedSeverity =
          item.severity === 'INFO' ||
          item.severity === 'WARNING' ||
          item.severity === 'ERROR' ||
          item.severity === 'CRITICAL'
            ? item.severity
            : item.severity === 'WARN'
              ? 'WARNING'
              : status === 'FAIL'
                ? 'ERROR'
                : status === 'WARN'
                  ? 'WARNING'
                  : 'INFO';
        const outputSummaryObj: Record<string, unknown> | undefined =
          item.outputSummary && typeof item.outputSummary === 'object' && !Array.isArray(item.outputSummary)
            ? { ...(item.outputSummary as Record<string, unknown>) }
            : typeof item.errorMessage === 'string'
              ? {}
              : undefined;
        if (outputSummaryObj && typeof item.errorMessage === 'string') {
          outputSummaryObj.errorMessage = item.errorMessage.slice(0, 300);
        }

        const emitted = emitter.emit({
          spanId: typeof item.spanId === 'string' && item.spanId.trim() ? item.spanId.trim().slice(0, 80) : undefined,
          contractVersion:
            typeof item.contractVersion === 'number' && Number.isFinite(item.contractVersion)
              ? Math.trunc(item.contractVersion)
              : undefined,
          journey,
          stage,
          tier: stage === 7 || stage >= 8 ? 'TIER_1' : 'TIER_2',
          environment: normalizeEnvironmentMode(
            (typeof item.environment === 'string' ? item.environment : undefined) ?? c.env.ENVIRONMENT
          ),
          userId: verifiedUserId,
          botId: derivedBotId,
          traceId: typeof item.traceId === 'string' ? item.traceId.slice(0, 80) : undefined,
          cycleId: typeof item.cycleId === 'string' ? item.cycleId.slice(0, 80) : undefined,
          alertId: typeof item.alertId === 'string' ? item.alertId.slice(0, 100) : undefined,
          orderId: typeof item.orderId === 'string' ? item.orderId.slice(0, 100) : undefined,
          fcmMessageId: typeof item.fcmMessageId === 'string' ? item.fcmMessageId.slice(0, 160) : undefined,
          androidDeviceSessionHash:
            verifiedDeviceSessionHash ??
            (typeof item.androidDeviceSessionHash === 'string'
              ? item.androidDeviceSessionHash.slice(0, 64)
              : undefined),
          symbol: typeof item.symbol === 'string' ? item.symbol.slice(0, 32) : undefined,
          strategyId: typeof item.strategyId === 'string' ? item.strategyId.slice(0, 64) : undefined,
          timeframe: typeof item.timeframe === 'string' ? item.timeframe.slice(0, 16) : undefined,
          component,
          sourceFile: typeof item.sourceFile === 'string' ? item.sourceFile.slice(0, 120) : undefined,
          eventType,
          status,
          severity: normalizedSeverity,
          emittedAtMs:
            typeof item.emittedAtMs === 'number' && Number.isFinite(item.emittedAtMs)
              ? Math.trunc(item.emittedAtMs)
              : Date.now(),
          durationMs:
            typeof item.durationMs === 'number' && Number.isFinite(item.durationMs)
              ? Math.max(0, Math.round(item.durationMs))
              : undefined,
          errorCode: typeof item.errorCode === 'string' ? item.errorCode.slice(0, 80) : undefined,
          message,
          inputSummary:
            item.inputSummary && typeof item.inputSummary === 'object' && !Array.isArray(item.inputSummary)
              ? (item.inputSummary as Record<string, unknown>)
              : undefined,
          outputSummary: outputSummaryObj,
          metadata:
            item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
              ? (item.metadata as Record<string, unknown>)
              : undefined
        });
        if (emitted) {
          acceptedIds.push(emitted.spanId);
        }
      }

      let deliveryMilestone: string = 'EVENT_CREATED';
      const safeWaitUntil = getSafeWaitUntil(c);
      try {
        const flushRes = await emitter.flush();
        const stats = emitter.getHealthStats();
        deliveryMilestone =
          stats.queueAccepted > 0 || stats.httpFallbackSucceeded > 0 || flushRes.sentEvents > 0
            ? 'QUEUE_ACCEPTED'
            : stats.queueSendAttempted > 0
              ? 'QUEUE_SEND_ATTEMPTED'
              : 'EVENT_CREATED';
      } catch {
        emitter.scheduleFlush(safeWaitUntil);
      }

      return c.json(
        {
          success: true,
          accepted: acceptedIds.length,
          ids: acceptedIds,
          deliveryMilestone
        },
        202
      );
    }

    // 4. Force verified identity and bot ownership (never trust caller-supplied userId)
    const sanitizedBody = {
      ...rawBody,
      source: isClientReport ? 'ANDROID' : (rawBody.source || 'BACKEND'),
      userId: verifiedUserId,
      botId: derivedBotId
    };

    const validation = validateMonitoringEvent(sanitizedBody);
    if (!validation.valid || !validation.event) {
      return c.json({ error: 'Bad Request', message: validation.error || 'Invalid event payload.' }, 400);
    }

    const monitoring = MonitoringService.getInstance();
    await monitoring.recordEvent(validation.event, {
      db: c.env.DB,
      waitUntil: getSafeWaitUntil(c)
    });

    return c.json({ success: true, id: validation.event.id, fingerprint: validation.event.fingerprint }, 202);
  } catch (err: any) {
    console.error('[AdminMonitoring] handleReportClientIncident error:', err);
    return c.json({ error: 'Internal Error', message: 'Failed to record diagnostic event.' }, 500);
  }
}
