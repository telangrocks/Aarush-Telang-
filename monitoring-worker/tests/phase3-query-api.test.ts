import { describe, it, expect, beforeEach } from 'vitest';
import { TelemetryQueueEnvelope } from '../../shared/monitoring';
import { ingestEnvelope } from '../src/consumer';
import { handleMonitorFetch } from '../src/index';
import { MonitoringEnv } from '../src/types';
import { SqliteD1Database } from './helpers/sqliteD1';

async function signAdminJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const b64u = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u(payload);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${Buffer.from(sig).toString('base64url')}`;
}

describe('Phase 3 — Strictly Read-Only Monitoring v2 Query API', () => {
  let db: SqliteD1Database;
  let env: MonitoringEnv;
  const adminHeaders = { 'X-Admin-Key': 'phase3-admin-secret' };

  beforeEach(() => {
    db = new SqliteD1Database();
    env = {
      MONITORING_DB: db,
      ENVIRONMENT: 'testnet',
      ADMIN_API_KEY: 'phase3-admin-secret',
      JWT_SECRET: 'phase3-jwt-secret',
      ADMIN_EMAILS: 'ops@cryptopulse.test',
    };
  });

  async function seedFullPipeline(nowMs = Date.now()) {
    const discEnvelope: TelemetryQueueEnvelope = {
      batchId: 'bat_disc_1',
      producer: 'crypto-pulse-backend',
      producedAtMs: nowMs,
      events: [
        {
          schemaVersion: 2,
          spanId: 'spn_d1',
          journey: 'JOURNEY_A_DISCOVERY',
          stage: 1,
          tier: 'TIER_2',
          eventType: 'PUBLIC_REST_TICKERS_FETCH',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          userId: 'user_ops_1',
          discoveryCycleId: 'disc_cycle_12',
          approvalGeneration: 12,
          stageSeq: 1,
          emittedAtMs: nowMs - 4000,
          durationMs: 42,
          deliveryMilestone: 'EVENT_CREATED',
          component: 'PublicMarketDataService',
          message: 'Fetched 450 Bybit public tickers via L3 cache fallback',
          outputSummary: {
            channel: 'PUBLIC_MARKET_DATA',
            endpoint: '/v5/market/tickers',
            httpStatus: 200,
            retCode: 0,
            latencyMs: 42,
            cacheTier: 'L3',
            instrumentsRequested: 450,
            instrumentsReceived: 450,
            staleCount: 0,
            invalidCount: 0,
          },
        },
        {
          schemaVersion: 2,
          spanId: 'spn_d2_ok',
          journey: 'JOURNEY_A_DISCOVERY',
          stage: 2,
          tier: 'TIER_1',
          eventType: 'TICKER_ELIGIBLE',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          userId: 'user_ops_1',
          discoveryCycleId: 'disc_cycle_12',
          approvalGeneration: 12,
          stageSeq: 2,
          emittedAtMs: nowMs - 3500,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'BTC/USDT',
          component: 'MarketOpportunityScanner',
          message: 'BTC/USDT passed budget eligibility',
          outputSummary: {
            eligible: true,
            decisionOutcome: 'ELIGIBLE',
            allocatedBudgetUsdt: 100,
            lastPrice: 50000,
            minOrderQty: 0.001,
            minNotionalValue: 5,
            qtyStep: 0.001,
            computedQty: 0.002,
            computedNotional: 100,
          },
        },
        {
          schemaVersion: 2,
          spanId: 'spn_d2_rej',
          journey: 'JOURNEY_A_DISCOVERY',
          stage: 2,
          tier: 'TIER_1',
          eventType: 'TICKER_REJECTED',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          userId: 'user_ops_1',
          discoveryCycleId: 'disc_cycle_12',
          approvalGeneration: 12,
          stageSeq: 3,
          emittedAtMs: nowMs - 3400,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'TINY/USDT',
          component: 'MarketOpportunityScanner',
          message: 'TINY/USDT rejected: notional below minimum',
          outputSummary: {
            eligible: false,
            decisionOutcome: 'REJECTED_MIN_NOTIONAL',
            rejectionReason: 'ALLOCATED_BUDGET_BELOW_MIN_NOTIONAL',
            allocatedBudgetUsdt: 10,
            minNotionalValue: 50,
            downstreamLeaked: 0,
          },
        },
        {
          schemaVersion: 2,
          spanId: 'spn_d4_skip',
          journey: 'JOURNEY_A_DISCOVERY',
          stage: 4,
          tier: 'TIER_1',
          eventType: 'TA_COMPUTED',
          status: 'SKIPPED',
          severity: 'WARNING',
          environment: 'testnet',
          userId: 'user_ops_1',
          discoveryCycleId: 'disc_cycle_12',
          approvalGeneration: 12,
          stageSeq: 4,
          emittedAtMs: nowMs - 3200,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'TINY/USDT',
          timeframe: '1h',
          component: 'MarketOpportunityScanner',
          errorCode: 'INSUFFICIENT_BARS',
          message: 'Skipped TA calculation due to 6 < 20 bars',
          outputSummary: {
            indicatorEngine: 'SCANNER_SIMPLE',
            skipReason: 'INSUFFICIENT_BARS',
            candlesCount: 6,
            minRequiredBars: 20,
            rsi: null,
            ema21: null,
            macdLine: null,
          },
        },
      ],
    };

    const autoEnvelope: TelemetryQueueEnvelope = {
      batchId: 'bat_auto_1',
      producer: 'trading-bot-do',
      producedAtMs: nowMs,
      events: [
        {
          schemaVersion: 2,
          spanId: 'spn_b1_priv',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 1,
          tier: 'TIER_2',
          eventType: 'BYBIT_PRIVATE_BALANCE_CHECK',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          userId: 'user_ops_1',
          botId: 'bot_user_ops',
          parentApprovalGeneration: 12,
          cycleId: 'CYC-B-101',
          traceId: 'trc_b_101',
          stageSeq: 1,
          emittedAtMs: nowMs - 2800,
          durationMs: 65,
          deliveryMilestone: 'EVENT_CREATED',
          component: 'BybitAdapter',
          message: 'Private account connectivity verified',
          outputSummary: {
            channel: 'PRIVATE_ACCOUNT',
            endpoint: '/v5/account/wallet-balance',
            httpStatus: 200,
            retCode: 0,
            latencyMs: 65,
            tokensRemaining: 98,
          },
        },
        {
          schemaVersion: 2,
          spanId: 'spn_b4_pass',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 4,
          tier: 'TIER_1',
          eventType: 'TA_COMPUTED',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          userId: 'user_ops_1',
          parentApprovalGeneration: 12,
          cycleId: 'CYC-B-101',
          traceId: 'trc_b_101',
          stageSeq: 2,
          emittedAtMs: nowMs - 2500,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'BTC/USDT',
          timeframe: '15m',
          component: 'StrategyOrchestrator',
          message: 'Computed canonical indicators for BTC/USDT 15m',
          outputSummary: {
            indicatorEngine: 'CANONICAL',
            candlesCount: 205,
            minRequiredBars: 50,
            rsi: 44.8,
            ema21: 49920,
            adx: 28.4,
            vwap: 49950,
            regime: 'TRENDING_UP',
          },
        },
        {
          schemaVersion: 2,
          spanId: 'spn_b5_strat',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 5,
          tier: 'TIER_1',
          eventType: 'STRATEGY_EVALUATED',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          userId: 'user_ops_1',
          cycleId: 'CYC-B-101',
          traceId: 'trc_b_101',
          stageSeq: 3,
          emittedAtMs: nowMs - 2400,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'BTC/USDT',
          timeframe: '15m',
          strategyId: 'ScalperV2',
          component: 'StrategyOrchestrator',
          message: 'ScalperV2 generated BUY signal',
          outputSummary: { confidence: 0.84, signalSide: 'BUY' },
        },
        {
          schemaVersion: 2,
          spanId: 'spn_b6_shadow',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 6,
          tier: 'TIER_1',
          eventType: 'SIGNAL_SHADOW_DIFF',
          status: 'WARN',
          severity: 'WARNING',
          environment: 'testnet',
          userId: 'user_ops_1',
          cycleId: 'CYC-B-101',
          traceId: 'trc_b_101',
          stageSeq: 4,
          emittedAtMs: nowMs - 2300,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'BTC/USDT',
          timeframe: '15m',
          strategyId: 'ScalperV2',
          component: 'SignalLifecycleManager',
          sourceFile: 'backend/src/trading-bot.ts',
          message: 'SHADOW mode disagreed on secondary candidate',
          outputSummary: {
            gateName: 'SignalLifecycleManager[SHADOW]',
            gateCategory: 'LIFECYCLE_SHADOW',
            decision: 'SHADOW_DIVERGED',
            reason: 'LEGACY_SELECTED_DIFFERENT_TIMEFRAME',
          },
        },
        {
          schemaVersion: 2,
          spanId: 'spn_b6_tv',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 6,
          tier: 'TIER_1',
          eventType: 'TRADE_VALIDATOR_CHECK',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          userId: 'user_ops_1',
          cycleId: 'CYC-B-101',
          traceId: 'trc_b_101',
          alertId: 'alert_q3_1',
          stageSeq: 5,
          emittedAtMs: nowMs - 2200,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'BTC/USDT',
          timeframe: '15m',
          strategyId: 'ScalperV2',
          component: 'TradeValidator',
          sourceFile: 'backend/src/trading-bot.ts',
          message: 'TradeValidator passed',
          outputSummary: {
            gateName: 'TradeValidator',
            gateCategory: 'PRE_DISPATCH_VALIDATION',
            decision: 'PASS',
          },
        },
        // Trade 1: full execution with HTTP ACK + Fill Confirmed + SL/TP Protected
        {
          schemaVersion: 2,
          spanId: 'spn_b7_ack1',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 7,
          tier: 'TIER_1',
          eventType: 'BYBIT_HTTP_ACK',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          userId: 'user_ops_1',
          cycleId: 'CYC-B-101',
          traceId: 'trc_b_101',
          alertId: 'alert_q3_1',
          intentId: 'int_q3_1',
          clientOrderId: 'cli_q3_1',
          orderId: 'ord_q3_1',
          stageSeq: 6,
          emittedAtMs: nowMs - 2000,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'BTC/USDT',
          strategyId: 'ScalperV2',
          timeframe: '15m',
          component: 'TradingBot',
          message: 'Bybit HTTP 200 ACK received',
          outputSummary: { side: 'BUY', requestedQty: 0.002, requestedPrice: 50000, retCode: 0, retMsg: 'OK' },
        },
        {
          schemaVersion: 2,
          spanId: 'spn_b7_fill1',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 7,
          tier: 'TIER_1',
          eventType: 'EXCHANGE_FILL_CONFIRMED',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          userId: 'user_ops_1',
          cycleId: 'CYC-B-101',
          traceId: 'trc_b_101',
          alertId: 'alert_q3_1',
          intentId: 'int_q3_1',
          clientOrderId: 'cli_q3_1',
          orderId: 'ord_q3_1',
          stageSeq: 7,
          emittedAtMs: nowMs - 1900,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'BTC/USDT',
          strategyId: 'ScalperV2',
          timeframe: '15m',
          component: 'TradingBot',
          message: 'Exchange fill confirmed',
          outputSummary: { side: 'BUY', filledQty: 0.002, avgFillPrice: 50005, slPrice: 49000, tpPrice: 52000 },
        },
        {
          schemaVersion: 2,
          spanId: 'spn_b7_prot1',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 7,
          tier: 'TIER_1',
          eventType: 'EXCHANGE_SL_TP_CONFIRMED',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          userId: 'user_ops_1',
          cycleId: 'CYC-B-101',
          traceId: 'trc_b_101',
          alertId: 'alert_q3_1',
          intentId: 'int_q3_1',
          orderId: 'ord_q3_1',
          stageSeq: 8,
          emittedAtMs: nowMs - 1800,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'BTC/USDT',
          component: 'ReconciliationEngine',
          message: 'SL/TP protection verified',
        },
        // Trade 2: Ack-only order (BYBIT_HTTP_ACK without EXCHANGE_FILL_CONFIRMED)
        {
          schemaVersion: 2,
          spanId: 'spn_b7_ack_only',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 7,
          tier: 'TIER_1',
          eventType: 'BYBIT_HTTP_ACK',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          userId: 'user_ops_1',
          cycleId: 'CYC-B-101',
          traceId: 'trc_b_101',
          alertId: 'alert_ack_only',
          intentId: 'int_ack_only',
          clientOrderId: 'cli_ack_only',
          orderId: 'ord_ack_only',
          stageSeq: 9,
          emittedAtMs: nowMs - 1700,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'ETH/USDT',
          strategyId: 'ScalperV2',
          timeframe: '15m',
          component: 'TradingBot',
          message: 'Limit order ACKed, resting on book',
          outputSummary: { side: 'BUY', requestedQty: 0.03, requestedPrice: 3000, retCode: 0, retMsg: 'OK', isAckOnly: true },
        },
        // Stage 8 + Stage 9 notifications (one MATCHED, one MISMATCH / POST_CHECK_MISSING, one SUPPRESSED)
        {
          schemaVersion: 2,
          spanId: 'spn_b8_fcm1',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 8,
          tier: 'TIER_1',
          eventType: 'FCM_ALERT_DISPATCHED',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          userId: 'user_ops_1',
          cycleId: 'CYC-B-101',
          traceId: 'trc_b_101',
          alertId: 'alert_q3_1',
          fcmMessageId: 'projects/cp/messages/fcm_1',
          stageSeq: 10,
          emittedAtMs: nowMs - 1600,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'BTC/USDT',
          strategyId: 'ScalperV2',
          timeframe: '15m',
          component: 'notifications',
          message: 'FCM trade alert dispatched',
          outputSummary: { fcmHttpStatus: 200, symbol: 'BTC/USDT', strategyId: 'ScalperV2', timeframe: '15m', price: 50000 },
        },
        {
          schemaVersion: 2,
          spanId: 'spn_b8_fcm_err',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 8,
          tier: 'TIER_1',
          eventType: 'FCM_DISPATCH_FAILED',
          status: 'FAIL',
          severity: 'ERROR',
          environment: 'testnet',
          userId: 'user_ops_1',
          cycleId: 'CYC-B-101',
          traceId: 'trc_b_101',
          alertId: 'alert_fcm_err',
          stageSeq: 11,
          emittedAtMs: nowMs - 1500,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'SOL/USDT',
          strategyId: 'Momentum',
          component: 'notifications',
          errorCode: 'FCM_UNREGISTERED',
          message: 'FCM token expired / unregistered',
        },
      ],
    };

    const androidEnvelope: TelemetryQueueEnvelope = {
      batchId: 'bat_and_1',
      producer: 'android-app',
      producedAtMs: nowMs,
      events: [
        {
          schemaVersion: 2,
          spanId: 'spn_a9_render',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          tier: 'TIER_1',
          eventType: 'ANDROID_POPUP_RENDERED',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          userId: 'user_ops_1',
          cycleId: 'CYC-B-101',
          traceId: 'trc_b_101',
          alertId: 'alert_q3_1',
          fcmMessageId: 'projects/cp/messages/fcm_1',
          androidDeviceSessionHash: 'dev_hash_1',
          stageSeq: 12,
          emittedAtMs: nowMs - 1200,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'BTC/USDT',
          strategyId: 'ScalperV2',
          timeframe: '15m',
          component: 'TradeAlertScreen',
          message: 'Trade popup rendered',
          outputSummary: {
            eligibilityOutcome: 'ELIGIBLE_OS_UNPROVABLE',
            postNotifyVerified: true,
            renderedFields: { symbol: 'BTC/USDT', strategyId: 'ScalperV2', timeframe: '15m', price: 50000 },
          },
        },
        {
          schemaVersion: 2,
          spanId: 'spn_a9_suppressed',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          tier: 'TIER_1',
          eventType: 'ANDROID_NOTIFICATION_POST_CHECK',
          status: 'WARN',
          severity: 'WARNING',
          environment: 'testnet',
          userId: 'user_ops_1',
          alertId: 'alert_suppressed',
          fcmMessageId: 'projects/cp/messages/fcm_suppressed',
          androidDeviceSessionHash: 'dev_hash_1',
          stageSeq: 13,
          emittedAtMs: nowMs - 1100,
          deliveryMilestone: 'EVENT_CREATED',
          symbol: 'DOGE/USDT',
          component: 'TradeAlertManager',
          message: 'Notifications blocked by OS channel precheck',
          outputSummary: {
            eligibilityOutcome: 'SUPPRESSED_PRECHECK',
            reason: 'CHANNEL_MUTED',
            postNotifyVerified: false,
          },
        },
      ],
    };

    await ingestEnvelope(db, discEnvelope);
    await ingestEnvelope(db, autoEnvelope);
    await ingestEnvelope(db, androidEnvelope);
  }

  it('strictly enforces read-only HTTP 405 on all non-GET methods and enforces admin auth', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await handleMonitorFetch(
        new Request('https://monitor.test/api/monitor/v2/incidents/fp_1/status', {
          method,
          headers: adminHeaders,
          body: method === 'DELETE' ? undefined : JSON.stringify({ status: 'RESOLVED' }),
        }),
        env
      );
      expect(res.status).toBe(405);
    }

    const noAuth = await handleMonitorFetch(new Request('https://monitor.test/api/monitor/v2/overview'), env);
    expect(noAuth.status).toBe(401);

    const badKey = await handleMonitorFetch(
      new Request('https://monitor.test/api/monitor/v2/overview', { headers: { 'X-Admin-Key': 'wrong' } }),
      env
    );
    expect(badKey.status).toBe(401);

    const nonAdminJwt = await signAdminJwt({ sub: 'u1', role: 'USER', exp: Math.floor(Date.now() / 1000) + 300 }, 'phase3-jwt-secret');
    const forbidden = await handleMonitorFetch(
      new Request('https://monitor.test/api/monitor/v2/overview', { headers: { Authorization: `Bearer ${nonAdminJwt}` } }),
      env
    );
    expect(forbidden.status).toBe(403);

    const adminJwt = await signAdminJwt({ sub: 'u_admin', role: 'ADMIN', exp: Math.floor(Date.now() / 1000) + 300 }, 'phase3-jwt-secret');
    const okJwt = await handleMonitorFetch(
      new Request('https://monitor.test/api/monitor/v2/overview', { headers: { Authorization: `Bearer ${adminJwt}` } }),
      env
    );
    expect(okJwt.status).toBe(200);
  });

  it('reports DISCONNECTED when DB is empty and STALE when telemetry is old (never fakes connected)', async () => {
    const emptyRes = await handleMonitorFetch(
      new Request('https://monitor.test/api/monitor/v2/overview', { headers: adminHeaders }),
      env
    );
    expect(emptyRes.status).toBe(200);
    const emptyJson = (await emptyRes.json()) as any;
    expect(emptyJson.overallVerdict).toBe('NO_TELEMETRY');
    expect(emptyJson.exchangeHealth.publicMarketData.honestState).toBe('DISCONNECTED');
    expect(emptyJson.exchangeHealth.privateAccount.honestState).toBe('DISCONNECTED');
    expect(emptyJson.stages).toHaveLength(9);
    expect(emptyJson.stages.every((s: any) => s.honestState === 'DISCONNECTED')).toBe(true);

    // Seed old telemetry (12 minutes ago, default window 60m) -> STALE stages & channel
    const staleNow = Date.now() - 12 * 60_000;
    await ingestEnvelope(db, {
      batchId: 'bat_stale',
      producer: 'trading-bot-do',
      producedAtMs: staleNow,
      events: [
        {
          schemaVersion: 2,
          spanId: 'spn_stale_1',
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 1,
          tier: 'TIER_2',
          eventType: 'PUBLIC_REST_TICKERS_FETCH',
          status: 'PASS',
          severity: 'INFO',
          environment: 'testnet',
          stageSeq: 1,
          emittedAtMs: staleNow,
          deliveryMilestone: 'EVENT_CREATED',
          component: 'BybitAdapter',
          message: 'Old healthy tick',
          outputSummary: { channel: 'PUBLIC_MARKET_DATA', latencyMs: 30, httpStatus: 200 },
        },
      ],
    });

    const staleRes = await handleMonitorFetch(
      new Request('https://monitor.test/api/monitor/v2/overview?windowMinutes=60', { headers: adminHeaders }),
      env
    );
    const staleJson = (await staleRes.json()) as any;
    expect(staleJson.stages[0].honestState).toBe('STALE');
    expect(staleJson.exchangeHealth.publicMarketData.honestState).toBe('STALE');
    expect(staleJson.exchangeHealth.privateAccount.honestState).toBe('DISCONNECTED');
    expect(staleJson.overallVerdict).toBe('STALE');
  });

  it('serves all v2 monitoring endpoints accurately across full 9-stage seeded pipeline', async () => {
    await seedFullPipeline();

    // 1. /overview
    const ovRes = await handleMonitorFetch(new Request('https://monitor.test/api/monitor/v2/overview', { headers: adminHeaders }), env);
    expect(ovRes.status).toBe(200);
    const ov = (await ovRes.json()) as any;
    expect(ov.journeys.handoff.handoffLinked).toBe(true);
    expect(ov.journeys.handoff.parentApprovalGeneration).toBe(12);
    expect(ov.journeys.handoff.linkedDiscoveryCycleId).toBe('disc_cycle_12');
    expect(ov.journeys.stage2Summary.eligibleCount).toBe(1);
    expect(ov.journeys.stage2Summary.rejectedCount).toBe(1);
    expect(ov.exchangeHealth.publicMarketData.honestState).toBe('CONNECTED');
    expect(ov.exchangeHealth.privateAccount.honestState).toBe('CONNECTED');
    expect(ov.stages.find((s: any) => s.stage === 8).honestState).toBe('FAIL');

    // 2. /traces & /traces/:id + handoff links + 404
    const trListRes = await handleMonitorFetch(
      new Request('https://monitor.test/api/monitor/v2/traces?approvalGeneration=12&limit=500', { headers: adminHeaders }),
      env
    );
    const trList = (await trListRes.json()) as any;
    expect(trList.limit).toBe(100); // clamped
    expect(trList.items.length).toBe(2);

    const trDetailRes = await handleMonitorFetch(
      new Request('https://monitor.test/api/monitor/v2/traces/trc_b_101', { headers: adminHeaders }),
      env
    );
    expect(trDetailRes.status).toBe(200);
    const trDetail = (await trDetailRes.json()) as any;
    expect(trDetail.handoff.upstreamDiscovery.discoveryCycleId).toBe('disc_cycle_12');
    expect(trDetail.spans.length).toBeGreaterThanOrEqual(7);

    const tr404 = await handleMonitorFetch(
      new Request('https://monitor.test/api/monitor/v2/traces/does_not_exist', { headers: adminHeaders }),
      env
    );
    expect(tr404.status).toBe(404);

    // 3. /ta + Stage 2 leak check + null preservation
    const taRes = await handleMonitorFetch(new Request('https://monitor.test/api/monitor/v2/ta', { headers: adminHeaders }), env);
    const taJson = (await taRes.json()) as any;
    const skippedRow = taJson.items.find((r: any) => r.status === 'SKIPPED');
    const passRow = taJson.items.find((r: any) => r.status === 'PASS');
    expect(skippedRow.rsi).toBeNull();
    expect(skippedRow.ema21).toBeNull();
    expect(skippedRow.antiFabricationVerified).toBe(true);
    expect(passRow.rsi).toBe(44.8);
    expect(passRow.indicatorEngine).toBe('CANONICAL');
    expect(taJson.stage2LeakCheck.downstreamLeakedCount).toBeGreaterThanOrEqual(1);

    // 4. /strategies-gates + shadow diff + [NOT_IN_LIVE_PATH] disclosure
    const sgRes = await handleMonitorFetch(
      new Request('https://monitor.test/api/monitor/v2/strategies-gates', { headers: adminHeaders }),
      env
    );
    const sgJson = (await sgRes.json()) as any;
    expect(sgJson.shadowModeComparisons.length).toBe(1);
    expect(sgJson.deadUnwiredComponents.map((d: any) => d.status)).toEqual(['[NOT_IN_LIVE_PATH]', '[NOT_IN_LIVE_PATH]']);

    // 5. /trades & /trades/:id (BYBIT_HTTP_ACK != EXCHANGE_FILL_CONFIRMED)
    const tradesRes = await handleMonitorFetch(new Request('https://monitor.test/api/monitor/v2/trades', { headers: adminHeaders }), env);
    const tradesJson = (await tradesRes.json()) as any;
    const filledTrade = tradesJson.items.find((t: any) => t.alertId === 'alert_q3_1');
    const ackOnlyTrade = tradesJson.items.find((t: any) => t.alertId === 'alert_ack_only');
    expect(filledTrade.isAckOnly).toBe(false);
    expect(filledTrade.hasFillConfirmation).toBe(true);
    expect(filledTrade.hasProtectionConfirmed).toBe(true);
    expect(ackOnlyTrade.isAckOnly).toBe(true);
    expect(ackOnlyTrade.hasFillConfirmation).toBe(false);

    const tdRes = await handleMonitorFetch(new Request('https://monitor.test/api/monitor/v2/trades/ord_q3_1', { headers: adminHeaders }), env);
    expect(tdRes.status).toBe(200);
    const tdJson = (await tdRes.json()) as any;
    expect(tdJson.notifications.length).toBe(1);
    expect((await handleMonitorFetch(new Request('https://monitor.test/api/monitor/v2/trades/nonexistent', { headers: adminHeaders }), env)).status).toBe(404);

    // 6. /notifications
    const notifRes = await handleMonitorFetch(new Request('https://monitor.test/api/monitor/v2/notifications', { headers: adminHeaders }), env);
    const notifJson = (await notifRes.json()) as any;
    expect(notifJson.summary.eligibleOsUnprovableCount).toBe(1);
    expect(notifJson.summary.suppressedPrecheckCount).toBe(1);

    // 7. /incidents & /incidents/:id
    const incRes = await handleMonitorFetch(new Request('https://monitor.test/api/monitor/v2/incidents', { headers: adminHeaders }), env);
    const incJson = (await incRes.json()) as any;
    expect(incJson.items.length).toBeGreaterThanOrEqual(1);
    const fp = incJson.items[0].fingerprint;
    const incDet = await handleMonitorFetch(new Request(`https://monitor.test/api/monitor/v2/incidents/${encodeURIComponent(fp)}`, { headers: adminHeaders }), env);
    expect(incDet.status).toBe(200);
    expect(((await incDet.json()) as any).recentOccurrences.length).toBeGreaterThanOrEqual(1);

    // 8. /self-health
    const shRes = await handleMonitorFetch(new Request('https://monitor.test/api/monitor/v2/self-health', { headers: adminHeaders }), env);
    const shJson = (await shRes.json()) as any;
    expect(shJson.honestState).toBe('HEALTHY');
    expect(shJson.tableCounts.trades).toBe(2);

    // 9. /live-probe (unbound vs mock BACKEND_SERVICE)
    const unboundProbe = await handleMonitorFetch(new Request('https://monitor.test/api/monitor/v2/live-probe', { headers: adminHeaders }), env);
    expect(((await unboundProbe.json()) as any).backendProbeStatus).toBe('BACKEND_SERVICE_UNBOUND');

    env.BACKEND_SERVICE = {
      fetch: async (input: RequestInfo | URL) => {
        expect(String(input)).toContain('/api/admin/monitoring/health?userId=user_ops_1');
        return new Response(
          JSON.stringify({
            timestamp: Date.now(),
            worker: { environment: 'testnet', signalManagerMode: 'SHADOW' },
            d1Database: { status: 'CONNECTED', latencyMs: 3 },
            publicMarketCoordinator: { hits: 12, status: 'WARM' },
            tradingBotState: { ok: true, readOnly: true, isActive: true, candidateApprovalGeneration: 12 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    } as unknown as Fetcher;

    const boundProbe = await handleMonitorFetch(new Request('https://monitor.test/api/monitor/v2/live-probe', { headers: adminHeaders }), env);
    const boundJson = (await boundProbe.json()) as any;
    expect(boundJson.backendProbeStatus).toBe('CONNECTED');
    expect(boundJson.coordinatorStats.status).toBe('WARM');
    expect(boundJson.tradingBotState.candidateApprovalGeneration).toBe(12);
    expect(boundJson.neverCallsExchange).toBe(true);
  });
});
