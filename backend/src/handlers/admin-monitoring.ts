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
      publicMarketCoordinator: coordinatorStats || { status: 'STANDBY' }
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

/**
 * Diagnostic ingestion endpoint for Android clients and internal services.
 * - For mobile clients: Authenticated via standard User JWT (/api/client/telemetry).
 * - For administrators: Authenticated via AdminAuth middleware (/api/admin/monitoring/report-incident).
 */
export async function handleReportClientIncident(c: Context<{ Bindings: Env }>) {
  try {
    const rawBody = await c.req.json();

    // 1. Strict payload size limit (max 4KB)
    const rawString = JSON.stringify(rawBody);
    if (rawString.length > 4096) {
      return c.json({ error: 'Payload Too Large', message: 'Diagnostic payload exceeds 4KB limit.' }, 413);
    }

    // 2. Identity Verification: Derive user ID from verified JWT session
    const jwtPayload = (c.get as any)('jwtPayload');
    const adminSession = (c.get as any)('adminSession');

    let verifiedUserId: string | undefined = undefined;
    let isClientReport = false;

    if (jwtPayload?.sub) {
      // Authenticated regular user (e.g. Android app)
      verifiedUserId = String(jwtPayload.sub);
      isClientReport = true;
    } else if (adminSession?.role === 'ADMIN') {
      // Administrative or internal report
      verifiedUserId = rawBody.userId ? String(rawBody.userId) : adminSession.userId;
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

    // 4. Force verified identity and bot ownership (never trust caller-supplied userId)
    const sanitizedBody = {
      ...rawBody,
      source: isClientReport ? 'ANDROID' : (rawBody.source || 'BACKEND'),
      userId: verifiedUserId,
      botId: verifiedUserId ? `bot_${verifiedUserId.slice(0, 8)}` : undefined
    };

    const validation = validateMonitoringEvent(sanitizedBody);
    if (!validation.valid || !validation.event) {
      return c.json({ error: 'Bad Request', message: validation.error || 'Invalid event payload.' }, 400);
    }

    const monitoring = MonitoringService.getInstance();
    await monitoring.recordEvent(validation.event, {
      db: c.env.DB,
      waitUntil: c.executionCtx ? (p) => c.executionCtx.waitUntil(p) : undefined
    });

    return c.json({ success: true, id: validation.event.id, fingerprint: validation.event.fingerprint }, 202);
  } catch (err: any) {
    console.error('[AdminMonitoring] handleReportClientIncident error:', err);
    return c.json({ error: 'Internal Error', message: 'Failed to record diagnostic event.' }, 500);
  }
}
