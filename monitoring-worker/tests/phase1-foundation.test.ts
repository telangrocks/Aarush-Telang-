import { describe, it, expect, beforeEach } from 'vitest';
import {
  TelemetryEmitter,
  TelemetryQueueEnvelope,
  sanitizeTelemetryEvent,
} from '../../shared/monitoring';
import {
  handleDlqBatch,
  handleQueueBatch,
  ingestEnvelope,
  pruneExpiredTelemetry,
} from '../src/consumer';
import worker, { handleMonitorFetch } from '../src/index';
import { MonitoringEnv } from '../src/types';
import { SqliteD1Database } from './helpers/sqliteD1';

async function signTestHs256Jwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const b64u = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u(payload);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${header}.${body}`)
  );
  const sig = Buffer.from(sigBuf).toString('base64url');
  return `${header}.${body}.${sig}`;
}

describe('Phase 1 — Monitoring Foundation, Sanitization, Consumer, DLQ & Read-Only Boundary', () => {
  let db: SqliteD1Database;
  let env: MonitoringEnv;

  beforeEach(() => {
    db = new SqliteD1Database();
    env = {
      MONITORING_DB: db,
      ENVIRONMENT: 'production',
      ADMIN_API_KEY: 'test-admin-secret-key',
      JWT_SECRET: 'test-jwt-secret-key-2026',
      ADMIN_EMAILS: 'ops@cryptopulse.test',
    };
  });

  it('strips all forbidden secrets, inline JWTs, Bearer tokens, and private keys, and bounds payload <=2048B with explicit flag', () => {
    const bigPayload: Record<string, unknown> = {
      apiKey: 'LIVE_BYBIT_KEY_123',
      apiSecret: 'LIVE_BYBIT_SECRET_999',
      password: 'UserPass!23',
      fcmToken: 'fcm_device_secret_token_abc',
      nested: {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.signature123',
        pem: '-----BEGIN PRIVATE KEY-----\nABC123\n-----END PRIVATE KEY-----',
        safeMetric: 42.5,
      },
      largeList: Array.from({ length: 40 }, (_, i) => ({ idx: i, val: 'X'.repeat(80) })),
    };

    const sanitized = sanitizeTelemetryEvent({
      journey: 'JOURNEY_B_AUTONOMOUS',
      stage: 1,
      tier: 'TIER_2',
      eventType: 'BYBIT_TICKER_FETCH',
      status: 'PASS',
      component: 'BybitAdapter',
      message: 'Fetched with Bearer secretToken123 and key=MY_SECRET_QUERY_KEY',
      inputSummary: bigPayload,
      outputSummary: {
        ok: true,
        jwtLeak: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiQURNSU4ifQ.sigPartXYZ',
      },
    });

    expect(sanitized).not.toBeNull();
    const json = JSON.stringify(sanitized);
    expect(json).not.toContain('LIVE_BYBIT_KEY_123');
    expect(json).not.toContain('LIVE_BYBIT_SECRET_999');
    expect(json).not.toContain('UserPass!23');
    expect(json).not.toContain('fcm_device_secret_token_abc');
    expect(json).not.toContain('secretToken123');
    expect(json).not.toContain('MY_SECRET_QUERY_KEY');
    expect(json).not.toContain('-----BEGIN PRIVATE KEY-----');
    expect(json).not.toContain('eyJhbGciOiJIUzI1NiJ9');

    expect(sanitized!.inputSummary?.truncationApplied).toBe(true);
    expect(JSON.stringify(sanitized!.inputSummary).length).toBeLessThanOrEqual(2048);
  });

  it('sheds TIER_3 first under buffer overflow, falls back from failing Queue to HTTP Service Binding, and never throws when both fail', async () => {
    const httpCalls: TelemetryQueueEnvelope[] = [];
    const emitter = new TelemetryEmitter({
      producer: 'trading-bot-do',
      maxBufferSize: 3,
      maxBatchSize: 10,
      queue: {
        async send() {
          throw new Error('Queue temporarily unavailable');
        },
      },
      httpFallback: {
        async fetch(_url, init) {
          httpCalls.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    });

    emitter.emit({ journey: 'JOURNEY_B_AUTONOMOUS', stage: 4, tier: 'TIER_3', eventType: 'TA_DEBUG', status: 'PASS', component: 'TA', message: 't3-a' });
    emitter.emit({ journey: 'JOURNEY_B_AUTONOMOUS', stage: 7, tier: 'TIER_1', eventType: 'ORDER_INTENT_RESERVED', status: 'PASS', component: 'Exec', message: 't1-keep' });
    emitter.emit({ journey: 'JOURNEY_B_AUTONOMOUS', stage: 3, tier: 'TIER_3', eventType: 'CANDLE_CACHE', status: 'PASS', component: 'Cache', message: 't3-b' });
    // Trigger overflow: TIER_3 must be evicted while TIER_1 stays intact
    emitter.emit({ journey: 'JOURNEY_B_AUTONOMOUS', stage: 7, tier: 'TIER_1', eventType: 'EXCHANGE_FILL_CONFIRMED', status: 'PASS', component: 'Exec', message: 't1-fill' });

    const snap = emitter.getBufferedEventsSnapshot();
    expect(snap).toHaveLength(3);
    expect(snap.filter((e) => e.tier === 'TIER_1').map((e) => e.eventType)).toEqual([
      'ORDER_INTENT_RESERVED',
      'EXCHANGE_FILL_CONFIRMED',
    ]);
    expect(emitter.getHealthStats().tier3ShedCount).toBe(1);

    const waitPromises: Promise<unknown>[] = [];
    emitter.scheduleFlush((p) => waitPromises.push(p));
    await Promise.all(waitPromises);

    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0].events.every((e) => e.deliveryMilestone === 'QUEUE_SEND_ATTEMPTED')).toBe(true);
    expect(emitter.getHealthStats().httpFallbackSucceeded).toBe(3);

    // Total outage: Queue rejects AND HTTP fallback rejects -> strictly fail-open, zero exceptions thrown
    emitter.updateBindings(
      { async send() { throw new Error('queue_down'); } },
      { async fetch() { return new Response('down', { status: 503 }); } }
    );
    emitter.emit({ journey: 'JOURNEY_B_AUTONOMOUS', stage: 7, tier: 'TIER_1', eventType: 'ORDER_SUBMIT_DISPATCHED', status: 'PASS', component: 'Exec', message: 'must not throw' });
    const res = await emitter.flush();
    expect(res).toEqual({ sentEvents: 0, failedEvents: 1 });
    expect(emitter.getHealthStats().queueSendFailed).toBe(1);
    expect(emitter.getHealthStats().httpFallbackFailed).toBe(1);
  });

  it('deduplicates repeated spanIds accurately without double-counting pipeline_cycles or incidents', async () => {
    const now = Date.now();
    const sharedEvent = {
      schemaVersion: 2 as const,
      spanId: 'spn_dedup_001',
      journey: 'JOURNEY_B_AUTONOMOUS' as const,
      stage: 7 as const,
      tier: 'TIER_1' as const,
      eventType: 'ORDER_SUBMIT_FAILED',
      status: 'FAIL' as const,
      severity: 'ERROR' as const,
      environment: 'testnet' as const,
      cycleId: 'CYC-100',
      traceId: 'TRC-100',
      stageSeq: 1,
      symbol: 'BTCUSDT',
      component: 'BybitAdapter',
      errorCode: 'BYBIT_10002',
      message: 'Timestamp timeout',
      emittedAtMs: now - 50,
      deliveryMilestone: 'QUEUE_SEND_ATTEMPTED' as const,
    };

    const out1 = await ingestEnvelope(db, {
      batchId: 'bat_1',
      producer: 'trading-bot-do',
      producedAtMs: now,
      events: [sharedEvent, { ...sharedEvent }],
    });

    expect(out1.inserted).toBe(1);
    expect(out1.deduped).toBe(1);

    // Second redelivery across batches
    const out2 = await ingestEnvelope(db, {
      batchId: 'bat_2',
      producer: 'trading-bot-do',
      producedAtMs: now + 10,
      events: [sharedEvent],
    });
    expect(out2.inserted).toBe(0);
    expect(out2.deduped).toBe(1);

    const inc = await db
      .prepare('SELECT occurrence_count FROM data_quality_incidents')
      .first<{ occurrence_count: number }>();
    expect(inc?.occurrence_count).toBe(1);

    const health = await db
      .prepare("SELECT events_received, events_inserted, events_deduped FROM monitoring_self_health WHERE metric_key = 'consumer_global'")
      .first<{ events_received: number; events_inserted: number; events_deduped: number }>();
    expect(health).toEqual({
      events_received: 3,
      events_inserted: 1,
      events_deduped: 2,
    });
  });

  it('converges out-of-order Stage 7 milestones without regressing FILL_CONFIRMED and keeps BYBIT_HTTP_ACK distinct from fill', async () => {
    const baseMs = Date.now() - 2000;
    // First: BYBIT_HTTP_ACK alone must NOT set exchange_fill_confirmed_at_ms or FILL_CONFIRMED
    await ingestEnvelope(db, {
      batchId: 'bat_ack',
      producer: 'crypto-pulse-backend',
      producedAtMs: baseMs + 100,
      events: [
        {
          schemaVersion: 2,
          spanId: 'spn_s7_ack',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 7,
          tier: 'TIER_1',
          eventType: 'BYBIT_HTTP_ACK',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          cycleId: 'CYC-77',
          traceId: 'TRC-77',
          clientOrderId: 'CID-77',
          orderId: 'ORD-77',
          stageSeq: 3,
          symbol: 'ETHUSDT',
          component: 'BybitAdapter',
          message: 'Bybit HTTP 200 order accepted',
          emittedAtMs: baseMs + 100,
          deliveryMilestone: 'QUEUE_SEND_ATTEMPTED',
          outputSummary: { retCode: 0, orderId: 'ORD-77' },
        },
      ],
    });

    const afterAck = await db
      .prepare('SELECT execution_status, bybit_http_ack_at_ms, exchange_fill_confirmed_at_ms FROM trade_lifecycle_ledger WHERE client_order_id = ?')
      .bind('CID-77')
      .first<Record<string, unknown>>();
    expect(afterAck?.execution_status).toBe('BYBIT_ACKED');
    expect(afterAck?.bybit_http_ack_at_ms).toBe(baseMs + 100);
    expect(afterAck?.exchange_fill_confirmed_at_ms).toBeNull();

    // Next: EXCHANGE_FILL_CONFIRMED arrives BEFORE ORDER_SUBMIT_DISPATCHED
    await ingestEnvelope(db, {
      batchId: 'bat_fill',
      producer: 'crypto-pulse-backend',
      producedAtMs: baseMs + 300,
      events: [
        {
          schemaVersion: 2,
          spanId: 'spn_s7_fill',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 7,
          tier: 'TIER_1',
          eventType: 'EXCHANGE_FILL_CONFIRMED',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          cycleId: 'CYC-77',
          traceId: 'TRC-77',
          clientOrderId: 'CID-77',
          orderId: 'ORD-77',
          stageSeq: 5,
          symbol: 'ETHUSDT',
          component: 'ReconciliationEngine',
          message: 'Order filled cleanly',
          emittedAtMs: baseMs + 250,
          deliveryMilestone: 'QUEUE_SEND_ATTEMPTED',
          outputSummary: { filledQty: 0.5, avgFillPrice: 3100.5 },
        },
      ],
    });

    // Late arrival of earlier ORDER_SUBMIT_DISPATCHED
    await ingestEnvelope(db, {
      batchId: 'bat_late_dispatch',
      producer: 'trading-bot-do',
      producedAtMs: baseMs + 400,
      events: [
        {
          schemaVersion: 2,
          spanId: 'spn_s7_disp',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 7,
          tier: 'TIER_1',
          eventType: 'ORDER_SUBMIT_DISPATCHED',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          cycleId: 'CYC-77',
          traceId: 'TRC-77',
          clientOrderId: 'CID-77',
          stageSeq: 2,
          symbol: 'ETHUSDT',
          component: 'TradingBotDO',
          message: 'Order dispatched to BybitAdapter',
          emittedAtMs: baseMs + 50,
          deliveryMilestone: 'QUEUE_SEND_ATTEMPTED',
        },
      ],
    });

    const finalTrade = await db
      .prepare('SELECT * FROM trade_lifecycle_ledger WHERE client_order_id = ?')
      .bind('CID-77')
      .first<Record<string, unknown>>();
    expect(finalTrade?.execution_status).toBe('FILL_CONFIRMED');
    expect(finalTrade?.current_milestone).toBe('EXCHANGE_FILL_CONFIRMED');
    expect(finalTrade?.order_submit_dispatched_at_ms).toBe(baseMs + 50);
    expect(finalTrade?.bybit_http_ack_at_ms).toBe(baseMs + 100);
    expect(finalTrade?.exchange_fill_confirmed_at_ms).toBe(baseMs + 250);
    expect(finalTrade?.avg_fill_price).toBe(3100.5);
  });

  it('reconciles out-of-order Stage 9 before Stage 8 and flags placeholder estimatedPnl=3.0 & missing timeframe defects', async () => {
    const now = Date.now();
    // Android renders BEFORE Backend Stage 8 arrives
    await ingestEnvelope(db, {
      batchId: 'bat_android_first',
      producer: 'android-client',
      producedAtMs: now - 100,
      events: [
        {
          schemaVersion: 2,
          spanId: 'spn_s9_render',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          tier: 'TIER_1',
          eventType: 'ANDROID_ALERT_RENDERED',
          status: 'PASS',
          severity: 'INFO',
          environment: 'mainnet',
          alertId: 'ALT-555',
          symbol: 'SOLUSDT',
          strategyId: 'scalper_v2',
          stageSeq: 2,
          component: 'TradeAlertScreen',
          message: 'Rendered trade alert popup',
          emittedAtMs: now - 100,
          deliveryMilestone: 'QUEUE_SEND_ATTEMPTED',
          outputSummary: {
            postNotifyVerified: true,
            renderedFields: { symbol: 'SOLUSDT', strategyId: 'scalper_v2', price: 145.2 },
          },
        },
      ],
    });

    const beforeBackend = await db
      .prepare('SELECT parity_status, android_os_heads_up_state FROM notification_parity_ledger WHERE alert_id = ?')
      .bind('ALT-555')
      .first<{ parity_status: string; android_os_heads_up_state: string }>();
    expect(beforeBackend?.parity_status).toBe('PENDING_BACKEND');
    expect(beforeBackend?.android_os_heads_up_state).toBe('ELIGIBLE_OS_UNPROVABLE');

    // Backend Stage 8 arrives late with fill notification defect flags (estimatedPnl=3.0 & missing timeframe)
    await ingestEnvelope(db, {
      batchId: 'bat_backend_late',
      producer: 'crypto-pulse-backend',
      producedAtMs: now,
      events: [
        {
          schemaVersion: 2,
          spanId: 'spn_s8_fcm',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 8,
          tier: 'TIER_1',
          eventType: 'FCM_FILL_DISPATCHED',
          status: 'WARN',
          severity: 'WARNING',
          environment: 'mainnet',
          alertId: 'ALT-555',
          fcmMessageId: 'projects/cp/messages/888',
          symbol: 'SOLUSDT',
          strategyId: 'scalper_v2',
          stageSeq: 1,
          component: 'notifications.ts',
          message: 'Sent trade fill push via FCM v1',
          emittedAtMs: now - 150,
          deliveryMilestone: 'QUEUE_SEND_ATTEMPTED',
          outputSummary: {
            notificationType: 'TRADE_FILL',
            fcmHttpStatus: 200,
            fcmDispatchStatus: 'SENT',
            hasPlaceholderPnl3: true,
            hasTimeframe: false,
            price: 145.2,
          },
        },
      ],
    });

    const merged = await db
      .prepare('SELECT parity_status, parity_mismatches_json, fcm_message_id FROM notification_parity_ledger WHERE alert_id = ?')
      .bind('ALT-555')
      .first<{ parity_status: string; parity_mismatches_json: string; fcm_message_id: string }>();
    expect(merged?.parity_status).toBe('PARITY_MISMATCH');
    expect(merged?.fcm_message_id).toBe('projects/cp/messages/888');
    expect(JSON.parse(merged!.parity_mismatches_json)).toEqual([
      'DEFECT_PLACEHOLDER_PNL_3',
      'BACKEND_MISSING_TIMEFRAME',
    ]);
  });

  it('detects Stage 2 rejected ticker downstream leaks and preserves NULL indicators on SKIPPED Stage 4 TA snapshots', async () => {
    const now = Date.now();
    await ingestEnvelope(db, {
      batchId: 'bat_s2_s4',
      producer: 'crypto-pulse-backend',
      producedAtMs: now,
      events: [
        {
          schemaVersion: 2,
          spanId: 'spn_s2_rej',
          journey: 'JOURNEY_A_DISCOVERY',
          discoveryCycleId: 'DISC-12',
          approvalGeneration: 12,
          stage: 2,
          tier: 'TIER_2',
          eventType: 'TICKER_REJECTED',
          status: 'PASS',
          severity: 'INFO',
          environment: 'mainnet',
          stageSeq: 1,
          symbol: 'DOGEUSDT',
          component: 'ExecutionEligibilityGate',
          message: 'Below minNotionalValue',
          emittedAtMs: now - 200,
          deliveryMilestone: 'QUEUE_SEND_ATTEMPTED',
          inputSummary: { allocatedBudgetUsdt: 4, minNotionalValue: 5 },
          outputSummary: { eligible: false, rejectionReason: 'MIN_NOTIONAL_UNMET' },
        },
        {
          schemaVersion: 2,
          spanId: 'spn_s4_leak',
          journey: 'JOURNEY_B_AUTONOMOUS',
          parentApprovalGeneration: 12,
          cycleId: 'CYC-12',
          traceId: 'TRC-12',
          stage: 4,
          tier: 'TIER_2',
          eventType: 'TA_COMPUTED',
          status: 'SKIPPED',
          severity: 'WARNING',
          environment: 'mainnet',
          stageSeq: 2,
          symbol: 'DOGEUSDT',
          timeframe: '1h',
          component: 'IndicatorEngine',
          message: 'Skipped 1h EMA200 due to insufficient bars',
          emittedAtMs: now - 100,
          deliveryMilestone: 'QUEUE_SEND_ATTEMPTED',
          inputSummary: { candlesCount: 120, minRequiredBars: 200 },
          // Even if caller passed fake numbers alongside SKIPPED, consumer must store NULL!
          outputSummary: { skipReason: 'INSUFFICIENT_BARS', rsi: 50, ema200: 0 },
        },
      ],
    });

    const s2 = await db
      .prepare('SELECT eligible, downstream_leaked, rejection_reason FROM stage2_eligibility_decisions WHERE symbol = ?')
      .bind('DOGEUSDT')
      .first<{ eligible: number; downstream_leaked: number; rejection_reason: string }>();
    expect(s2).toEqual({
      eligible: 0,
      downstream_leaked: 1,
      rejection_reason: 'MIN_NOTIONAL_UNMET',
    });

    const s4 = await db
      .prepare('SELECT status, skip_reason, rsi, ema200 FROM ta_indicator_snapshots WHERE symbol = ?')
      .bind('DOGEUSDT')
      .first<{ status: string; skip_reason: string; rsi: number | null; ema200: number | null }>();
    expect(s4).toEqual({
      status: 'SKIPPED',
      skip_reason: 'INSUFFICIENT_BARS',
      rsi: null,
      ema200: null,
    });
  });

  it('handles D1 write failures with atomic rollback, retry(), DLQ persistence, and TTL expiration purge', async () => {
    const now = Date.now();
    // Simulate D1 failure on stage_spans write inside queue batch
    db.injectErrorOnMatch = {
      pattern: /INSERT INTO pipeline_cycles/i,
      error: new Error('D1_SQLITE_BUSY'),
      remaining: 1,
    };

    let acked = 0;
    let retried = 0;
    const envelope: TelemetryQueueEnvelope = {
      batchId: 'bat_fail_1',
      producer: 'trading-bot-do',
      producedAtMs: now,
      events: [
        {
          schemaVersion: 2,
          spanId: 'spn_rollback_1',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 7,
          tier: 'TIER_1',
          eventType: 'ORDER_INTENT_RESERVED',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          cycleId: 'CYC-ERR',
          traceId: 'TRC-ERR',
          stageSeq: 1,
          symbol: 'BTCUSDT',
          component: 'TradingBotDO',
          message: 'Intent reserved',
          emittedAtMs: now - 10,
          deliveryMilestone: 'QUEUE_SEND_ATTEMPTED',
        },
      ],
    };

    await handleQueueBatch(
      {
        queue: 'monitoring-telemetry-ingest',
        messages: [
          {
            id: 'msg-1',
            timestamp: new Date(),
            body: envelope,
            attempts: 1,
            ack: () => { acked += 1; },
            retry: () => { retried += 1; },
          },
        ],
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as MessageBatch<TelemetryQueueEnvelope>,
      env
    );

    expect(acked).toBe(0);
    expect(retried).toBe(1);
    // Atomic rollback: stage_spans must remain empty!
    const rolledBackCount = await db
      .prepare('SELECT COUNT(*) AS cnt FROM stage_spans WHERE span_id = ?')
      .bind('spn_rollback_1')
      .first<{ cnt: number }>();
    expect(rolledBackCount?.cnt).toBe(0);

    const errHealth = await db
      .prepare("SELECT d1_write_errors, last_error FROM monitoring_self_health WHERE metric_key = 'consumer_global'")
      .first<{ d1_write_errors: number; last_error: string }>();
    expect(errHealth?.d1_write_errors).toBe(1);
    expect(errHealth?.last_error).toContain('D1_SQLITE_BUSY');

    // Simulate DLQ routing after max retries
    let dlqAcked = 0;
    await handleDlqBatch(
      {
        queue: 'monitoring-telemetry-dlq',
        messages: [
          {
            id: 'msg-dlq-1',
            timestamp: new Date(),
            body: envelope,
            attempts: 3,
            ack: () => { dlqAcked += 1; },
            retry: () => {},
          },
        ],
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as MessageBatch<TelemetryQueueEnvelope>,
      env
    );
    expect(dlqAcked).toBe(1);
    const dlqRow = await db
      .prepare('SELECT batch_id, event_count FROM telemetry_dlq_records')
      .first<{ batch_id: string; event_count: number }>();
    expect(dlqRow).toEqual({ batch_id: 'bat_fail_1', event_count: 1 });

    // Retention / TTL purge test: old diagnostic span (20d old) pruned, recent Tier 1 kept
    const oldMs = now - 20 * 24 * 60 * 60 * 1000;
    await ingestEnvelope(db, {
      batchId: 'bat_ttl',
      producer: 'crypto-pulse-backend',
      producedAtMs: now,
      events: [
        {
          schemaVersion: 2,
          spanId: 'spn_old_diag',
          journey: 'JOURNEY_A_DISCOVERY',
          stage: 2,
          tier: 'TIER_3',
          eventType: 'OLD_DIAG',
          status: 'PASS',
          severity: 'INFO',
          environment: 'mainnet',
          stageSeq: 1,
          component: 'Scanner',
          message: 'old',
          emittedAtMs: oldMs,
          deliveryMilestone: 'QUEUE_SEND_ATTEMPTED',
        },
        {
          schemaVersion: 2,
          spanId: 'spn_fresh_tier1',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 7,
          tier: 'TIER_1',
          eventType: 'FRESH_FILL',
          status: 'PASS',
          severity: 'INFO',
          environment: 'mainnet',
          stageSeq: 1,
          symbol: 'BTCUSDT',
          component: 'BybitAdapter',
          message: 'fresh',
          emittedAtMs: now - 1000,
          deliveryMilestone: 'QUEUE_SEND_ATTEMPTED',
        },
      ],
    });

    const purged = await pruneExpiredTelemetry(db, now);
    expect(purged.stage_spans).toBe(1);
    const remaining = await db
      .prepare('SELECT span_id FROM stage_spans')
      .all<{ span_id: string }>();
    expect(remaining.results?.map((r) => r.span_id)).toEqual(['spn_fresh_tier1']);
  });

  it('enforces strictly read-only HTTP methods, auth boundary, and tail crash capture', async () => {
    // Any mutation HTTP method on /api/monitor/v2/* MUST fail with 405 Method Not Allowed
    const patchIncidentRes = await handleMonitorFetch(
      new Request('https://monitor.local/api/monitor/v2/incidents/fp_123/status', {
        method: 'PATCH',
        headers: { 'X-Admin-Key': 'test-admin-secret-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'RESOLVED' }),
      }),
      env
    );
    expect(patchIncidentRes.status).toBe(405);

    const postActionRes = await handleMonitorFetch(
      new Request('https://monitor.local/api/monitor/v2/overview', { method: 'POST' }),
      env
    );
    expect(postActionRes.status).toBe(405);

    // Unauthenticated GET -> 401
    const unauthRes = await handleMonitorFetch(
      new Request('https://monitor.local/api/monitor/v2/self-health'),
      env
    );
    expect(unauthRes.status).toBe(401);

    // Non-admin JWT -> 403
    const userJwt = await signTestHs256Jwt(
      { sub: 'u_1', role: 'USER', email: 'trader@example.com', exp: Math.floor(Date.now() / 1000) + 300 },
      env.JWT_SECRET!
    );
    const forbiddenRes = await handleMonitorFetch(
      new Request('https://monitor.local/api/monitor/v2/self-health', {
        headers: { Authorization: `Bearer ${userJwt}` },
      }),
      env
    );
    expect(forbiddenRes.status).toBe(403);

    // Valid Admin JWT -> 200
    const adminJwt = await signTestHs256Jwt(
      { sub: 'adm_1', role: 'ADMIN', email: 'ops@cryptopulse.test', exp: Math.floor(Date.now() / 1000) + 300 },
      env.JWT_SECRET!
    );
    const okRes = await handleMonitorFetch(
      new Request('https://monitor.local/api/monitor/v2/self-health', {
        headers: { Authorization: `Bearer ${adminJwt}`, Origin: 'https://cryptopulse-monitoring.pages.dev' },
      }),
      env
    );
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('Access-Control-Allow-Origin')).toBe('https://cryptopulse-monitoring.pages.dev');

    // Browser Origin blocked on /internal/ingest -> 403
    const browserIngestRes = await handleMonitorFetch(
      new Request('https://monitor.local/internal/ingest', {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [] }),
      }),
      env
    );
    expect(browserIngestRes.status).toBe(403);

    // Tail handler ignores 'ok' outcomes and captures unhandled exceptions
    await worker.tail(
      [
        {
          event: null,
          eventTimestamp: Date.now(),
          logs: [],
          exceptions: [],
          diagnosticsChannelEvents: [],
          scriptName: 'crypto-pulse-backend',
          outcome: 'ok',
          executionModel: 'stateless',
          truncated: false,
          cpuTime: 2,
          wallTime: 5,
        },
        {
          event: null,
          eventTimestamp: Date.now(),
          logs: [],
          exceptions: [{ timestamp: Date.now(), name: 'TypeError', message: 'Bearer secretLeakXYZ crashed DO' }],
          diagnosticsChannelEvents: [],
          scriptName: 'crypto-pulse-backend',
          outcome: 'exception',
          executionModel: 'durableObject',
          truncated: false,
          cpuTime: 10,
          wallTime: 18,
        },
      ],
      env
    );

    const tailSpan = await db
      .prepare("SELECT event_type, severity, message FROM stage_spans WHERE event_type = 'TAIL_UNHANDLED_EXCEPTION'")
      .first<{ event_type: string; severity: string; message: string }>();
    expect(tailSpan?.event_type).toBe('TAIL_UNHANDLED_EXCEPTION');
    expect(tailSpan?.severity).toBe('CRITICAL');
    expect(tailSpan?.message).toContain('Bearer [REDACTED]');
    expect(tailSpan?.message).not.toContain('secretLeakXYZ');
  });
});
