/**
 * MonitoringService.ts
 *
 * Centralized, cost-free monitoring service for CryptoPulse.
 *
 * Cost & Scale Architecture:
 * - Normal cycles & heartbeats are aggregated in isolate memory (0 D1 writes).
 * - Only ERROR & CRITICAL incidents and safety gate breaches are durably persisted to D1.
 * - Deduplicates repeated errors using stable fingerprints.
 * - Non-blocking fail-safe: monitoring errors never propagate to the caller or interrupt trading.
 * - Bounded memory: hard-capped ring buffers and LRU deduplication caches.
 */

import {
  MonitoringEvent,
  MonitoringSeverity,
  validateMonitoringEvent,
  generateEventFingerprint,
  IncidentStatus
} from './MonitoringEvent';

export interface IncidentQueryFilters {
  severity?: MonitoringSeverity;
  source?: string;
  component?: string;
  status?: IncidentStatus;
  userId?: string;
  correlationId?: string;
  since?: number;
  until?: number;
  search?: string;
  page?: number;
  limit?: number;
}

export interface QuotaAndHealthStats {
  totalEventsReceived: number;
  totalIncidentsPersisted: number;
  totalDeduplicated: number;
  totalDropped: number;
  writeFailuresCount: number;
  lastEventAt: number | null;
  severityCounts: Record<MonitoringSeverity, number>;
  ringBufferSize: number;
  dedupCacheSize: number;
  storageHealth: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
}

export class MonitoringService {
  private static instance: MonitoringService;

  private static readonly MAX_RING_BUFFER = 150;
  private static readonly MAX_DEDUP_CACHE = 500;
  private static readonly DEDUP_WINDOW_MS = 15 * 60 * 1000; // 15-minute bounded deduplication window

  private readonly ringBuffer: MonitoringEvent[] = [];
  private readonly dedupCache = new Map<string, { incidentId: string; lastSeenAt: number; count: number }>();

  // Aggregate Counters
  private totalEventsReceived = 0;
  private totalIncidentsPersisted = 0;
  private totalDeduplicated = 0;
  private totalDropped = 0;
  private writeFailuresCount = 0;
  private lastEventAt: number | null = null;
  private severityCounts: Record<MonitoringSeverity, number> = {
    INFO: 0,
    WARNING: 0,
    ERROR: 0,
    CRITICAL: 0
  };

  private constructor() {}

  public static getInstance(): MonitoringService {
    if (!MonitoringService.instance) {
      MonitoringService.instance = new MonitoringService();
    }
    return MonitoringService.instance;
  }

  /**
   * Resets in-memory state (primarily for test isolation).
   */
  public resetForTesting(): void {
    this.ringBuffer.length = 0;
    this.dedupCache.clear();
    this.totalEventsReceived = 0;
    this.totalIncidentsPersisted = 0;
    this.totalDeduplicated = 0;
    this.totalDropped = 0;
    this.writeFailuresCount = 0;
    this.lastEventAt = null;
    this.severityCounts = { INFO: 0, WARNING: 0, ERROR: 0, CRITICAL: 0 };
  }

  /**
   * Records a monitoring event.
   * Total failure isolation: NEVER throws to caller.
   */
  public async recordEvent(
    rawEvent: Partial<MonitoringEvent>,
    options?: {
      db?: D1Database | null;
      waitUntil?: (promise: Promise<any>) => void;
    }
  ): Promise<void> {
    try {
      this.totalEventsReceived++;
      this.lastEventAt = Date.now();

      const validation = validateMonitoringEvent(rawEvent);
      if (!validation.valid || !validation.event) {
        this.totalDropped++;
        return;
      }

      const event = validation.event;
      this.severityCounts[event.severity] = (this.severityCounts[event.severity] || 0) + 1;

      // Maintain Bounded In-Memory Ring Buffer
      if (this.ringBuffer.length >= MonitoringService.MAX_RING_BUFFER) {
        this.ringBuffer.shift();
      }
      this.ringBuffer.push(event);

      // Console Logging for Cloudflare Workers Native Observability
      const logMsg = `[MONITORING] [${event.severity}] [${event.source}] [${event.component}] ${event.eventType}: ${event.message}`;
      if (event.severity === 'ERROR' || event.severity === 'CRITICAL') {
        console.error(logMsg);
      } else if (event.severity === 'WARNING') {
        console.warn(logMsg);
      } else {
        console.log(logMsg);
      }

      // Cost-free policy: Normal INFO and regular WARNING events remain in memory / console.
      // Only ERROR, CRITICAL, or Safety Gate Rejections are durably persisted to D1.
      const shouldPersist =
        event.severity === 'ERROR' ||
        event.severity === 'CRITICAL' ||
        event.eventType === 'FINAL_DISPATCH_GATE' ||
        event.eventType === 'CIRCUIT_BREAKER' ||
        event.eventType === 'RECONCILIATION_MISMATCH';

      if (!shouldPersist || !options?.db) {
        return;
      }

      // Handle Deduplication with Atomic Bounded-Window UPSERT
      const now = Date.now();
      const windowBucket = Math.floor(now / MonitoringService.DEDUP_WINDOW_MS);
      const existingDedup = this.dedupCache.get(event.fingerprint);

      if (existingDedup && now - existingDedup.lastSeenAt < MonitoringService.DEDUP_WINDOW_MS) {
        // Repeated occurrence within dedup window in this isolate
        this.totalDeduplicated++;
        existingDedup.count++;
        existingDedup.lastSeenAt = now;

        const persistUpdate = async () => {
          try {
            await options.db!.prepare(
              `UPDATE system_incidents
               SET occurrences = occurrences + 1, last_seen_at = ?
               WHERE fingerprint = ? AND window_bucket = ? AND status = 'UNRESOLVED'`
            )
              .bind(now, event.fingerprint, windowBucket)
              .run();
          } catch (dbErr) {
            this.writeFailuresCount++;
            console.warn('[MonitoringService] Dedup update failed:', dbErr);
          }
        };

        if (options.waitUntil) {
          options.waitUntil(persistUpdate());
        } else {
          await persistUpdate();
        }
        return;
      }

      // First time in this isolate or new window bucket
      if (this.dedupCache.size >= MonitoringService.MAX_DEDUP_CACHE) {
        // Prune oldest 20%
        const keysToPrune = Array.from(this.dedupCache.keys()).slice(0, 100);
        for (const k of keysToPrune) this.dedupCache.delete(k);
      }
      this.dedupCache.set(event.fingerprint, { incidentId: event.id, lastSeenAt: now, count: 1 });

      const persistInsert = async () => {
        try {
          const evidenceJson = event.evidence ? JSON.stringify(event.evidence) : null;
          await options.db!.prepare(
            `INSERT INTO system_incidents (
               id, timestamp, fingerprint, window_bucket, severity, source, environment,
               component, event_type, user_id, bot_id, correlation_id,
               lifecycle_stage, error_code, message, evidence,
               occurrences, first_seen_at, last_seen_at, status
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'UNRESOLVED')
             ON CONFLICT(fingerprint, window_bucket, status) DO UPDATE SET
               occurrences = occurrences + 1,
               last_seen_at = excluded.last_seen_at`
          )
            .bind(
              event.id,
              event.timestamp,
              event.fingerprint,
              windowBucket,
              event.severity,
              event.source,
              event.environment,
              event.component,
              event.eventType,
              event.userId || null,
              event.botId || null,
              event.correlationId || null,
              event.lifecycleStage || null,
              event.errorCode || null,
              event.message,
              evidenceJson,
              event.firstSeenAt,
              event.lastSeenAt
            )
            .run();

          this.totalIncidentsPersisted++;
        } catch (dbErr) {
          this.writeFailuresCount++;
          console.warn('[MonitoringService] D1 incident insert failed (degrading gracefully):', dbErr);
        }
      };

      if (options.waitUntil) {
        options.waitUntil(persistInsert());
      } else {
        await persistInsert();
      }
    } catch (unexpectedErr) {
      // ABSOLUTE ISOLATION: Never throw from monitoring
      this.writeFailuresCount++;
      console.error('[MonitoringService] Unexpected error in recordEvent:', unexpectedErr);
    }
  }

  /**
   * Retrieves recent events from in-memory ring buffer.
   */
  public getRecentEvents(limit = 50): MonitoringEvent[] {
    const safeLimit = Math.min(Math.max(limit, 1), MonitoringService.MAX_RING_BUFFER);
    return this.ringBuffer.slice(-safeLimit).reverse();
  }

  /**
   * Retrieves aggregated operational health metrics.
   */
  public getHealthStats(): QuotaAndHealthStats {
    let storageHealth: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' = 'HEALTHY';
    if (this.writeFailuresCount > 50) {
      storageHealth = 'DEGRADED';
    } else if (this.writeFailuresCount > 500) {
      storageHealth = 'UNAVAILABLE';
    }

    return {
      totalEventsReceived: this.totalEventsReceived,
      totalIncidentsPersisted: this.totalIncidentsPersisted,
      totalDeduplicated: this.totalDeduplicated,
      totalDropped: this.totalDropped,
      writeFailuresCount: this.writeFailuresCount,
      lastEventAt: this.lastEventAt,
      severityCounts: { ...this.severityCounts },
      ringBufferSize: this.ringBuffer.length,
      dedupCacheSize: this.dedupCache.size,
      storageHealth
    };
  }

  /**
   * Queries incidents from D1 with bounded pagination and fallback to in-memory ring buffer.
   */
  public async queryIncidents(
    db: D1Database | null | undefined,
    filters: IncidentQueryFilters
  ): Promise<{
    items: MonitoringEvent[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
    source: 'D1' | 'IN_MEMORY_FALLBACK';
  }> {
    const page = Math.max(Number(filters.page) || 1, 1);
    const limit = Math.min(Math.max(Number(filters.limit) || 20, 1), 100);
    const offset = (page - 1) * limit;

    // Fallback: If DB is unavailable, query in-memory ring buffer
    if (!db) {
      let memoryItems = [...this.ringBuffer];
      if (filters.severity) {
        memoryItems = memoryItems.filter((e) => e.severity === filters.severity);
      }
      if (filters.source) {
        memoryItems = memoryItems.filter((e) => e.source === filters.source);
      }
      if (filters.component) {
        memoryItems = memoryItems.filter((e) => e.component === filters.component);
      }
      if (filters.userId) {
        memoryItems = memoryItems.filter((e) => e.userId === filters.userId);
      }
      if (filters.search) {
        const s = filters.search.toLowerCase();
        memoryItems = memoryItems.filter(
          (e) => e.message.toLowerCase().includes(s) || e.eventType.toLowerCase().includes(s)
        );
      }

      memoryItems.sort((a, b) => b.timestamp - a.timestamp);
      const total = memoryItems.length;
      const paginated = memoryItems.slice(offset, offset + limit);

      return {
        items: paginated,
        total,
        page,
        limit,
        hasMore: offset + limit < total,
        source: 'IN_MEMORY_FALLBACK'
      };
    }

    try {
      // Build dynamic SQL query with parameterized bindings
      const conditions: string[] = [];
      const bindings: unknown[] = [];

      if (filters.severity) {
        conditions.push('severity = ?');
        bindings.push(filters.severity);
      }
      if (filters.source) {
        conditions.push('source = ?');
        bindings.push(filters.source);
      }
      if (filters.component) {
        conditions.push('component = ?');
        bindings.push(filters.component);
      }
      if (filters.status) {
        conditions.push('status = ?');
        bindings.push(filters.status);
      }
      if (filters.userId) {
        conditions.push('user_id = ?');
        bindings.push(filters.userId);
      }
      if (filters.correlationId) {
        conditions.push('correlation_id = ?');
        bindings.push(filters.correlationId);
      }
      if (filters.since) {
        conditions.push('timestamp >= ?');
        bindings.push(filters.since);
      }
      if (filters.until) {
        conditions.push('timestamp <= ?');
        bindings.push(filters.until);
      }
      if (filters.search) {
        conditions.push('(message LIKE ? OR event_type LIKE ? OR error_code LIKE ?)');
        const term = `%${filters.search}%`;
        bindings.push(term, term, term);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Count query
      const countSql = `SELECT COUNT(*) as total FROM system_incidents ${whereClause}`;
      const countRes = await db.prepare(countSql).bind(...bindings).first<{ total: number }>();
      const total = countRes?.total ?? 0;

      // Items query
      const itemsSql = `
        SELECT id, timestamp, fingerprint, severity, source, environment,
               component, event_type, user_id, bot_id, correlation_id,
               lifecycle_stage, error_code, message, evidence,
               occurrences, first_seen_at, last_seen_at, status,
               resolved_at, resolved_by, resolution_notes
        FROM system_incidents
        ${whereClause}
        ORDER BY last_seen_at DESC
        LIMIT ? OFFSET ?
      `;

      const rows = await db.prepare(itemsSql).bind(...bindings, limit, offset).all<any>();

      const items: MonitoringEvent[] = (rows.results || []).map((r: any) => {
        let evidenceObj: Record<string, unknown> | undefined;
        try {
          if (r.evidence) evidenceObj = JSON.parse(r.evidence);
        } catch (_) {}

        return {
          id: r.id,
          timestamp: r.timestamp,
          fingerprint: r.fingerprint,
          severity: r.severity,
          source: r.source,
          environment: r.environment,
          component: r.component,
          eventType: r.event_type,
          userId: r.user_id || undefined,
          botId: r.bot_id || undefined,
          correlationId: r.correlation_id || undefined,
          lifecycleStage: r.lifecycle_stage || undefined,
          errorCode: r.error_code || undefined,
          message: r.message,
          evidence: evidenceObj,
          occurrences: r.occurrences || 1,
          firstSeenAt: r.first_seen_at,
          lastSeenAt: r.last_seen_at,
          status: r.status,
          resolvedAt: r.resolved_at || undefined,
          resolvedBy: r.resolved_by || undefined,
          resolutionNotes: r.resolution_notes || undefined
        };
      });

      return {
        items,
        total,
        page,
        limit,
        hasMore: offset + limit < total,
        source: 'D1'
      };
    } catch (err) {
      console.warn('[MonitoringService] D1 query failed, falling back to memory buffer:', err);
      // Seamlessly fall back to ring buffer on missing table or D1 errors
      return this.queryIncidents(null, filters);
    }
  }

  /**
   * Retrieves single incident by ID.
   */
  public async getIncidentById(
    db: D1Database | null | undefined,
    id: string
  ): Promise<MonitoringEvent | null> {
    // Check ring buffer first for fastest response
    const memMatch = this.ringBuffer.find((e) => e.id === id);
    if (memMatch && !db) return memMatch;

    if (db) {
      try {
        const row = await db.prepare(
          `SELECT id, timestamp, fingerprint, severity, source, environment,
                  component, event_type, user_id, bot_id, correlation_id,
                  lifecycle_stage, error_code, message, evidence,
                  occurrences, first_seen_at, last_seen_at, status,
                  resolved_at, resolved_by, resolution_notes
           FROM system_incidents WHERE id = ?`
        )
          .bind(id)
          .first<any>();

        if (row) {
          let evidenceObj: Record<string, unknown> | undefined;
          try {
            if (row.evidence) evidenceObj = JSON.parse(row.evidence);
          } catch (_) {}

          return {
            id: row.id,
            timestamp: row.timestamp,
            fingerprint: row.fingerprint,
            severity: row.severity,
            source: row.source,
            environment: row.environment,
            component: row.component,
            eventType: row.event_type,
            userId: row.user_id || undefined,
            botId: row.bot_id || undefined,
            correlationId: row.correlation_id || undefined,
            lifecycleStage: row.lifecycle_stage || undefined,
            errorCode: row.error_code || undefined,
            message: row.message,
            evidence: evidenceObj,
            occurrences: row.occurrences || 1,
            firstSeenAt: row.first_seen_at,
            lastSeenAt: row.last_seen_at,
            status: row.status,
            resolvedAt: row.resolved_at || undefined,
            resolvedBy: row.resolved_by || undefined,
            resolutionNotes: row.resolution_notes || undefined
          };
        }
      } catch (err) {
        console.warn('[MonitoringService] getIncidentById D1 error:', err);
      }
    }

    return memMatch || null;
  }

  /**
   * Updates status of an incident (e.g. mark RESOLVED or INVESTIGATING).
   */
  public async updateIncidentStatus(
    db: D1Database | null | undefined,
    id: string,
    status: IncidentStatus,
    adminEmail?: string,
    notes?: string
  ): Promise<boolean> {
    const memMatch = this.ringBuffer.find((e) => e.id === id);
    if (memMatch) {
      memMatch.status = status;
      if (status === 'RESOLVED') {
        memMatch.resolvedAt = Date.now();
        memMatch.resolvedBy = adminEmail;
      }
      memMatch.resolutionNotes = notes;
    }

    if (db) {
      try {
        const now = Date.now();
        await db.prepare(
          `UPDATE system_incidents
           SET status = ?, resolved_at = ?, resolved_by = ?, resolution_notes = ?
           WHERE id = ?`
        )
          .bind(status, status === 'RESOLVED' ? now : null, adminEmail || null, notes || null, id)
          .run();
        return true;
      } catch (err) {
        console.warn('[MonitoringService] updateIncidentStatus D1 error:', err);
      }
    }

    return memMatch !== undefined;
  }
}
