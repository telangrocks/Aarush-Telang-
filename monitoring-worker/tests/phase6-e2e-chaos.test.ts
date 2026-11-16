import { describe, expect, it } from 'vitest';
import { SqliteD1Database } from './helpers/sqliteD1';
import { handleMonitorFetch } from '../src/index';
import { handleDlqBatch, handleQueueBatch } from '../src/consumer';
import { MonitoringEnv } from '../src/types';
import {
  PipelineTelemetryEvent,
  TelemetryEmitter,
  TelemetryQueueEnvelope,
} from '../../shared/monitoring';
import { runWithTelemetryContext } from '../../backend/src/infrastructure/monitoring/PipelineTelemetry';

function toBase64Url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function signAdminJwt(secret: string, email = 'ops@cryptopulse.test'): Promise<string> {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = toBase64Url(
    JSON.stringify({
      sub: 'admin_operator',
      role: 'ADMIN',
      monitoringScope: 'OPERATOR',
      email,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  );
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${toBase64Url(new Uint8Array(sig))}`;
}

function createEnv(db: SqliteD1Database): MonitoringEnv {
  return {
    MONITORING_DB: db,
    JWT_SECRET: 'e2e-jwt-secret',
    ADMIN_EMAILS: 'ops@cryptopulse.test',
    ADMIN_API_KEY: 'e2e-admin-key',
    INTERNAL_INGEST_SECRET: 'e2e-internal-secret',
    REQUIRE_INTERNAL_SECRET: 'false',
    ENVIRONMENT: 'mainnet',
    ALLOWED_ORIGINS: 'https://cryptopulse-monitoring.pages.dev',
  };
}

function makeQueueHarness() {
  const sentBatches: TelemetryQueueEnvelope[][] = [];
  const binding = {
    async send(message: TelemetryQueueEnvelope): Promise<void> {
      sentBatches.push([message]);
    },
    async sendBatch(messages: { body: TelemetryQueueEnvelope }[]): Promise<void> {
      sentBatches.push(messages.map((m) => m.body));
    },
  };
  return { sentBatches, binding };
}

async function deliverAllEnvelopes(envelopes: TelemetryQueueEnvelope[], env: MonitoringEnv) {
  const results = { acked: 0, retried: 0 };
  const messages = envelopes.map((body, idx) => ({
    id: `qmsg-${idx}-${body.batchId}`,
    timestamp: new Date(body.producedAtMs),
    body,
    attempts: 1,
    ack: () => {
      results.acked += 1;
    },
    retry: () => {
      results.retried += 1;
    },
  }));
  await handleQueueBatch(
    {
      queue: 'cryptopulse-telemetry',
      messages,
      retryAll: () => {},
      ackAll: () => {},
    } as any,
    env
  );
  return results;
}

async function apiGet(env: MonitoringEnv, jwt: string, path: string): Promise<{ status: number; body: any }> {
  const res = await handleMonitorFetch(
    new Request(`https://monitor.local${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${jwt}` },
    }),
    env
  );
  const body = await res.json();
  return { status: res.status, body };
}

describe('Phase 6: Full End-to-End 9-Stage Causal Flow & Chaos Resilience', () => {
  it('traces Journey A -> Journey B causality, Stage 2 zero-leak, Stage 7 split milestones, and Stage 8->9 parity cleanly', async () => {
    const db = new SqliteD1Database();
    const env = createEnv(db);
    const jwt = await signAdminJwt(env.JWT_SECRET!);
    const { sentBatches, binding } = makeQueueHarness();

    const scannerEmitter = new TelemetryEmitter({
      producer: 'public-market-coordinator',
      queue: binding,
      maxBufferSize: 200,
      maxBatchSize: 50,
    });
    const botEmitter = new TelemetryEmitter({
      producer: 'trading-bot-do',
      queue: binding,
      maxBufferSize: 200,
      maxBatchSize: 50,
    });
    const androidEmitter = new TelemetryEmitter({
      producer: 'android-app',
      queue: binding,
      maxBufferSize: 200,
      maxBatchSize: 50,
    });

    const t0 = Date.now() - 25_000;

    // Journey A: Shared Public Market Discovery (approvalGeneration = 42)
    runWithTelemetryContext(
      {
        journey: 'JOURNEY_A_DISCOVERY',
        discoveryCycleId: 'disc-e2e-42',
        approvalGeneration: 42,
        environment: 'mainnet',
        emitter: scannerEmitter,
      },
      () => {
        scannerEmitter.emit({
          journey: 'JOURNEY_A_DISCOVERY',
          discoveryCycleId: 'disc-e2e-42',
          approvalGeneration: 42,
          stage: 1,
          tier: 'TIER_2',
          stageSeq: 1,
          eventType: 'BYBIT_PUBLIC_FETCH_OK',
          status: 'PASS',
          component: 'BybitAdapter.fetchTickers',
          message: 'Fetched 240 public linear tickers from Bybit',
          emittedAtMs: t0 + 100,
          outputSummary: { httpStatus: 200, latencyMs: 64, instrumentCount: 240, btcLast: 67900, btcVolume24h: 185000000 },
        });
        scannerEmitter.emit({
          journey: 'JOURNEY_A_DISCOVERY',
          discoveryCycleId: 'disc-e2e-42',
          approvalGeneration: 42,
          stage: 2,
          tier: 'TIER_2',
          stageSeq: 2,
          eventType: 'SYMBOL_ELIGIBILITY_DECISION',
          status: 'PASS',
          symbol: 'BTC/USDT',
          component: 'MarketOpportunityScanner',
          message: 'BTC/USDT passed budget & lot rules (alloc=250 >= minNotional=5)',
          emittedAtMs: t0 + 250,
          outputSummary: { decision: 'ACCEPTED', availableBudgetUsdt: 1200, allocUsdt: 250, minNotional: 5 },
        });
        scannerEmitter.emit({
          journey: 'JOURNEY_A_DISCOVERY',
          discoveryCycleId: 'disc-e2e-42',
          approvalGeneration: 42,
          stage: 2,
          tier: 'TIER_2',
          stageSeq: 3,
          eventType: 'TICKER_REJECTED',
          status: 'SKIPPED',
          symbol: 'XRP/USDT',
          component: 'MarketOpportunityScanner',
          message: 'XRP/USDT rejected: allocation below minNotional',
          emittedAtMs: t0 + 260,
          outputSummary: {
            eligible: false,
            rejectionReason: 'BUDGET_BELOW_MIN_NOTIONAL',
            availableBudgetUsdt: 1200,
            allocUsdt: 4,
            minNotional: 10,
          },
        });
        scannerEmitter.emit({
          journey: 'JOURNEY_A_DISCOVERY',
          discoveryCycleId: 'disc-e2e-42',
          approvalGeneration: 42,
          stage: 3,
          tier: 'TIER_2',
          stageSeq: 4,
          eventType: 'CANDLE_FETCH_OK',
          status: 'PASS',
          symbol: 'BTC/USDT',
          timeframe: '15m',
          candleDatasetId: 'ds-btc-15m-42',
          component: 'PublicMarketDataService',
          message: 'Validated 120 closed 15m candles for BTC/USDT',
          emittedAtMs: t0 + 400,
          outputSummary: { barCount: 120, candleCount: 120, validationPassed: true, stale: false },
        });
      }
    );

    // Journey B: Autonomous User Cycle inheriting parentApprovalGeneration = 42
    runWithTelemetryContext(
      {
        journey: 'JOURNEY_B_AUTONOMOUS',
        userId: 'user-e2e-1',
        botId: 'bot-e2e-1',
        discoveryCycleId: 'disc-e2e-42',
        parentApprovalGeneration: 42,
        cycleId: 'cyc-e2e-42',
        traceId: 'tr-e2e-42',
        environment: 'mainnet',
        emitter: botEmitter,
      },
      () => {
        botEmitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          userId: 'user-e2e-1',
          botId: 'bot-e2e-1',
          discoveryCycleId: 'disc-e2e-42',
          parentApprovalGeneration: 42,
          cycleId: 'cyc-e2e-42',
          traceId: 'tr-e2e-42',
          candleDatasetId: 'ds-btc-15m-42',
          stage: 3,
          tier: 'TIER_2',
          stageSeq: 1,
          eventType: 'CANDLE_DATASET_BOUND',
          status: 'PASS',
          symbol: 'BTC/USDT',
          timeframe: '15m',
          component: 'MarketDataEngine',
          message: 'Bound 120 valid bars for BTC/USDT 15m',
          emittedAtMs: t0 + 1000,
          outputSummary: { barCount: 120, candleCount: 120, validationPassed: true },
        });
        botEmitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          userId: 'user-e2e-1',
          botId: 'bot-e2e-1',
          discoveryCycleId: 'disc-e2e-42',
          parentApprovalGeneration: 42,
          cycleId: 'cyc-e2e-42',
          traceId: 'tr-e2e-42',
          candleDatasetId: 'ds-btc-15m-42',
          stage: 4,
          tier: 'TIER_2',
          stageSeq: 2,
          eventType: 'TA_COMPUTED',
          status: 'PASS',
          symbol: 'BTC/USDT',
          timeframe: '15m',
          component: 'IndicatorEngine',
          message: 'Canonical indicators computed across 120 bars',
          emittedAtMs: t0 + 1150,
          outputSummary: {
            barCount: 120,
            rsi: 34.2,
            ema9: 67800.5,
            ema21: 67500.0,
            atr: 410.25,
            vwap: 67650.1,
            adx: 26.5,
          },
        });
        botEmitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          userId: 'user-e2e-1',
          botId: 'bot-e2e-1',
          discoveryCycleId: 'disc-e2e-42',
          parentApprovalGeneration: 42,
          cycleId: 'cyc-e2e-42',
          traceId: 'tr-e2e-42',
          stage: 5,
          tier: 'TIER_2',
          stageSeq: 3,
          eventType: 'SIGNAL_SELECTED',
          status: 'PASS',
          symbol: 'BTC/USDT',
          strategyId: 'ScalperV2',
          timeframe: '15m',
          alertId: 'alt-e2e-1',
          component: 'StrategyOrchestrator',
          message: 'Selected BUY signal from ScalperV2 (confidence=0.84)',
          emittedAtMs: t0 + 1300,
          outputSummary: {
            selectedStrategy: 'ScalperV2',
            confidence: 0.84,
            strategiesEvaluated: ['ScalperV2', 'Momentum', 'Breakout', 'MeanReversion', 'VWAP'],
          },
        });
        botEmitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          userId: 'user-e2e-1',
          botId: 'bot-e2e-1',
          parentApprovalGeneration: 42,
          cycleId: 'cyc-e2e-42',
          traceId: 'tr-e2e-42',
          stage: 6,
          tier: 'TIER_2',
          stageSeq: 4,
          eventType: 'SIGNAL_LIFECYCLE_DECISION',
          status: 'PASS',
          symbol: 'BTC/USDT',
          strategyId: 'ScalperV2',
          timeframe: '15m',
          alertId: 'alt-e2e-1',
          component: 'SignalLifecycleManager',
          message: 'Live & Shadow lifecycle agreed on PROMOTE',
          emittedAtMs: t0 + 1450,
          outputSummary: { liveDecision: 'PROMOTE', shadowDecision: 'PROMOTE', diverged: false, shadowOnly: true },
        });
        botEmitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          userId: 'user-e2e-1',
          botId: 'bot-e2e-1',
          parentApprovalGeneration: 42,
          cycleId: 'cyc-e2e-42',
          traceId: 'tr-e2e-42',
          stage: 6,
          tier: 'TIER_2',
          stageSeq: 5,
          eventType: 'FINAL_SAFETY_APPROVED',
          status: 'PASS',
          symbol: 'BTC/USDT',
          strategyId: 'ScalperV2',
          timeframe: '15m',
          alertId: 'alt-e2e-1',
          component: 'FinalDispatchSafetyGate',
          message: 'Fence A + Fence B + ExecutionEligibilityGate passed',
          emittedAtMs: t0 + 1500,
          outputSummary: { isExecutable: true, fenceA: 'PASS', fenceB: 'ACQUIRED' },
        });
        botEmitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          userId: 'user-e2e-1',
          botId: 'bot-e2e-1',
          parentApprovalGeneration: 42,
          cycleId: 'cyc-e2e-42',
          traceId: 'tr-e2e-42',
          stage: 7,
          tier: 'TIER_1',
          stageSeq: 6,
          eventType: 'ORDER_SUBMIT_DISPATCHED',
          status: 'PASS',
          symbol: 'BTC/USDT',
          strategyId: 'ScalperV2',
          timeframe: '15m',
          alertId: 'alt-e2e-1',
          intentId: 'intent-e2e-1',
          clientOrderId: 'clid-e2e-1',
          component: 'BybitAdapter.createOrder',
          message: 'Submitted BUY limit/market order to Bybit',
          emittedAtMs: t0 + 1650,
          outputSummary: { side: 'BUY', qty: 0.00368, price: 67900 },
        });
        botEmitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          userId: 'user-e2e-1',
          botId: 'bot-e2e-1',
          parentApprovalGeneration: 42,
          cycleId: 'cyc-e2e-42',
          traceId: 'tr-e2e-42',
          stage: 7,
          tier: 'TIER_1',
          stageSeq: 7,
          eventType: 'BYBIT_HTTP_ACK',
          status: 'PASS',
          symbol: 'BTC/USDT',
          alertId: 'alt-e2e-1',
          intentId: 'intent-e2e-1',
          clientOrderId: 'clid-e2e-1',
          orderId: 'bybit-ord-1',
          component: 'BybitAdapter.createOrder',
          message: 'Bybit HTTP Ack received (retCode=0)',
          emittedAtMs: t0 + 1800,
          outputSummary: { httpStatus: 200, orderId: 'bybit-ord-1', retCode: 0 },
        });
        botEmitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          userId: 'user-e2e-1',
          botId: 'bot-e2e-1',
          parentApprovalGeneration: 42,
          cycleId: 'cyc-e2e-42',
          traceId: 'tr-e2e-42',
          stage: 7,
          tier: 'TIER_1',
          stageSeq: 8,
          eventType: 'EXCHANGE_FILL_CONFIRMED',
          status: 'PASS',
          symbol: 'BTC/USDT',
          alertId: 'alt-e2e-1',
          intentId: 'intent-e2e-1',
          clientOrderId: 'clid-e2e-1',
          orderId: 'bybit-ord-1',
          component: 'ReconciliationEngine',
          message: 'Exchange fill verified (0.00368 @ 67910)',
          emittedAtMs: t0 + 2400,
          outputSummary: { filledQty: 0.00368, avgFillPrice: 67910, status: 'closed' },
        });
        botEmitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          userId: 'user-e2e-1',
          botId: 'bot-e2e-1',
          parentApprovalGeneration: 42,
          cycleId: 'cyc-e2e-42',
          traceId: 'tr-e2e-42',
          stage: 7,
          tier: 'TIER_1',
          stageSeq: 9,
          eventType: 'EXCHANGE_SL_TP_CONFIRMED',
          status: 'PASS',
          symbol: 'BTC/USDT',
          alertId: 'alt-e2e-1',
          intentId: 'intent-e2e-1',
          clientOrderId: 'clid-e2e-1',
          orderId: 'bybit-ord-1',
          component: 'ReconciliationEngine',
          message: 'SL/TP protection orders active on Bybit',
          emittedAtMs: t0 + 2600,
          outputSummary: { slPrice: 66800, tpPrice: 69900, verified: true },
        });
        botEmitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          userId: 'user-e2e-1',
          botId: 'bot-e2e-1',
          parentApprovalGeneration: 42,
          cycleId: 'cyc-e2e-42',
          traceId: 'tr-e2e-42',
          stage: 8,
          tier: 'TIER_1',
          stageSeq: 10,
          eventType: 'ALERT_PERSISTED',
          status: 'PASS',
          symbol: 'BTC/USDT',
          strategyId: 'ScalperV2',
          timeframe: '15m',
          alertId: 'alt-e2e-1',
          component: 'notifications.createTradeAlert',
          message: 'Persisted actionable TradeAlert alt-e2e-1',
          emittedAtMs: t0 + 2700,
          outputSummary: { strategyId: 'ScalperV2', timeframe: '15m', entryPrice: 67900 },
        });
        botEmitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          userId: 'user-e2e-1',
          botId: 'bot-e2e-1',
          parentApprovalGeneration: 42,
          cycleId: 'cyc-e2e-42',
          traceId: 'tr-e2e-42',
          stage: 8,
          tier: 'TIER_1',
          stageSeq: 11,
          eventType: 'FCM_DISPATCH_ATTEMPTED',
          status: 'PASS',
          symbol: 'BTC/USDT',
          strategyId: 'ScalperV2',
          timeframe: '15m',
          alertId: 'alt-e2e-1',
          fcmMessageId: 'fcm-msg-e2e-1',
          component: 'notifications.sendFcm',
          message: 'FCM HTTP v1 accepted message fcm-msg-e2e-1',
          emittedAtMs: t0 + 2850,
          outputSummary: { httpStatus: 200, success: true, fcmMessageId: 'fcm-msg-e2e-1', strategyId: 'ScalperV2', timeframe: '15m' },
        });
      }
    );

    // Stage 9 Android events ingested for user-e2e-1
    androidEmitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-e2e-1',
      stage: 9,
      tier: 'TIER_1',
      stageSeq: 1,
      eventType: 'ANDROID_FCM_RECEIVED',
      status: 'PASS',
      symbol: 'BTC/USDT',
      strategyId: 'ScalperV2',
      timeframe: '15m',
      alertId: 'alt-e2e-1',
      fcmMessageId: 'fcm-msg-e2e-1',
      component: 'FcmService.onMessageReceived',
      message: 'Android received FCM message',
      emittedAtMs: t0 + 3200,
      outputSummary: { channel: 'FCM', fcmMessageId: 'fcm-msg-e2e-1', hasDataPayload: true },
    });
    androidEmitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-e2e-1',
      stage: 9,
      tier: 'TIER_1',
      stageSeq: 2,
      eventType: 'ANDROID_NOTIFICATION_PRECHECK',
      status: 'PASS',
      symbol: 'BTC/USDT',
      strategyId: 'ScalperV2',
      timeframe: '15m',
      alertId: 'alt-e2e-1',
      component: 'TradeAlertManager.postSystemNotification',
      message: 'Precheck eligible',
      emittedAtMs: t0 + 3250,
      outputSummary: {
        notificationsEnabled: true,
        channelEnabled: true,
        channelImportance: 4,
        androidOsHeadsUpState: 'ELIGIBLE_OS_UNPROVABLE',
      },
    });
    androidEmitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-e2e-1',
      stage: 9,
      tier: 'TIER_1',
      stageSeq: 3,
      eventType: 'ANDROID_NOTIFICATION_POST_CHECK',
      status: 'PASS',
      symbol: 'BTC/USDT',
      strategyId: 'ScalperV2',
      timeframe: '15m',
      alertId: 'alt-e2e-1',
      component: 'TradeAlertManager.postSystemNotification',
      message: 'Post-check active notification confirmed',
      emittedAtMs: t0 + 3290,
      outputSummary: {
        notifySucceeded: true,
        postNotifyVerified: true,
        activeNotificationFound: true,
        notificationsEnabled: true,
        channelImportance: 4,
        androidOsHeadsUpState: 'ELIGIBLE_OS_UNPROVABLE',
      },
    });
    androidEmitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-e2e-1',
      stage: 9,
      tier: 'TIER_1',
      stageSeq: 4,
      eventType: 'ANDROID_POPUP_RENDERED',
      status: 'PASS',
      symbol: 'BTC/USDT',
      strategyId: 'ScalperV2',
      timeframe: '15m',
      alertId: 'alt-e2e-1',
      component: 'TradeAlertScreen',
      message: 'Trade popup rendered for BTC/USDT',
      emittedAtMs: t0 + 3500,
      outputSummary: {
        rendered: true,
        renderedFields: {
          symbol: 'BTC/USDT',
          strategyId: 'ScalperV2',
          timeframe: '15m',
          entryPrice: 67900,
          isExecutable: true,
        },
      },
    });

    await scannerEmitter.flush();
    await botEmitter.flush();
    await androidEmitter.flush();

    const envelopes = sentBatches.flat();
    expect(envelopes.length).toBeGreaterThanOrEqual(3);
    const delivery = await deliverAllEnvelopes(envelopes, env);
    expect(delivery.retried).toBe(0);
    expect(delivery.acked).toBe(envelopes.length);

    // 1. Overview causality
    const overview = await apiGet(env, jwt, '/api/monitor/v2/overview');
    const traceDetail = await apiGet(env, jwt, '/api/monitor/v2/traces/tr-e2e-42');
    const taRes = await apiGet(env, jwt, '/api/monitor/v2/ta?symbol=BTC/USDT');
    const stratRes = await apiGet(env, jwt, '/api/monitor/v2/strategies-gates');
    const tradesRes = await apiGet(env, jwt, '/api/monitor/v2/trades');
    const notifRes = await apiGet(env, jwt, '/api/monitor/v2/notifications');

    expect(overview.status).toBe(200);
    expect(overview.body.journeys?.latestDiscovery?.discoveryCycleId).toBe('disc-e2e-42');
    expect(overview.body.journeys?.latestDiscovery?.approvalGeneration).toBe(42);
    expect(overview.body.journeys?.latestAutonomous?.cycleId).toBe('cyc-e2e-42');
    expect(overview.body.journeys?.latestAutonomous?.parentApprovalGeneration).toBe(42);
    expect(overview.body.journeys?.handoff?.handoffLinked).toBe(true);
    expect(overview.body.journeys?.stage2Summary?.leakedCount).toBe(0);
    expect(overview.body.exchangeHealth?.publicMarketData?.honestState).toBe('CONNECTED');
    expect(overview.body.exchangeHealth?.privateAccount?.honestState).toBe('DISCONNECTED');

    // 2. Trace & Stage 4 TA & Stage 6 Strategies-Gates
    expect(traceDetail.status).toBe(200);
    expect(traceDetail.body.cycle?.traceId).toBe('tr-e2e-42');
    expect(traceDetail.body.handoff?.upstreamDiscovery?.discoveryCycleId).toBe('disc-e2e-42');
    expect((traceDetail.body.spans as any[]).length).toBeGreaterThanOrEqual(9);

    expect(taRes.status).toBe(200);
    expect(taRes.body.items[0].rsi).toBeCloseTo(34.2, 2);
    expect(taRes.body.items[0].vwap).toBeCloseTo(67650.1, 2);
    expect(taRes.body.items[0].antiFabricationVerified).toBe(true);
    expect(taRes.body.stage2LeakCheck?.downstreamLeakedCount).toBe(0);

    expect(stratRes.status).toBe(200);
    expect(JSON.stringify(stratRes.body.deadUnwiredComponents)).toContain('[NOT_IN_LIVE_PATH]');

    // 3. Stage 7 Trade Execution Split Milestones & Detail
    expect(tradesRes.status).toBe(200);
    expect(tradesRes.body.items.length).toBe(1);
    const trade = tradesRes.body.items[0];
    expect(trade.executionStatus).toBe('PROTECTED');
    expect(trade.isAckOnly).toBe(false);
    expect(trade.hasFillConfirmation).toBe(true);
    expect(trade.hasProtectionConfirmed).toBe(true);
    expect(trade.milestones?.orderSubmitDispatchedAtMs).toBeGreaterThan(0);
    expect(trade.milestones?.bybitHttpAckAtMs).toBeGreaterThan(0);
    expect(trade.milestones?.exchangeFillConfirmedAtMs).toBeGreaterThan(0);
    expect(trade.milestones?.exchangeSlTpConfirmedAtMs).toBeGreaterThan(0);

    const tradeDetail = await apiGet(env, jwt, `/api/monitor/v2/trades/${trade.tradeKey}`);
    expect(tradeDetail.status).toBe(200);

    // 4. Stage 8 -> Stage 9 Parity
    expect(notifRes.status).toBe(200);
    const ledger = notifRes.body.items[0];
    expect(ledger.parityStatus).toBe('PARITY_OK');
    expect(ledger.androidOsHeadsUpState).toBe('ELIGIBLE_OS_UNPROVABLE');
    expect(ledger.androidPostNotifyVerified).toBe(true);
    expect(ledger.androidRenderedAtMs).toBeGreaterThan(0);

    // 5. Read-only enforcement: all mutations must return 405
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const mutRes = await handleMonitorFetch(
        new Request('https://monitor.local/api/monitor/v2/incidents/any-id', {
          method,
          headers: { Authorization: `Bearer ${jwt}` },
        }),
        env
      );
      expect(mutRes.status).toBe(405);
    }
  });

  it('catches multi-stage chaos: Stage 1 500s, Stage 2 downstream leak, Stage 4 <20 bars NULLs, Stage 6 shadow divergence, Stage 7 ack-only, and Stage 8->9 mismatch + suppressed precheck', async () => {
    const db = new SqliteD1Database();
    const env = createEnv(db);
    const jwt = await signAdminJwt(env.JWT_SECRET!);
    const { sentBatches, binding } = makeQueueHarness();

    const emitter = new TelemetryEmitter({
      producer: 'trading-bot-do',
      queue: binding,
      maxBufferSize: 200,
      maxBatchSize: 50,
    });

    const t0 = Date.now() - 10_000;

    // Stage 1 Bybit outage
    emitter.emit({
      journey: 'JOURNEY_A_DISCOVERY',
      discoveryCycleId: 'disc-chaos-1',
      approvalGeneration: 77,
      stage: 1,
      tier: 'TIER_2',
      stageSeq: 1,
      eventType: 'BYBIT_PUBLIC_FETCH_FAILED',
      status: 'FAIL',
      severity: 'ERROR',
      errorCode: 'HTTP_500',
      component: 'BybitAdapter.fetchTickers',
      message: 'Bybit /v5/market/tickers returned HTTP 500',
      emittedAtMs: t0,
      outputSummary: { httpStatus: 500 },
    });

    // Stage 2 rejected DOGE/USDT (disc-chaos-1 / gen 77) followed by rogue Stage 4 leak inheriting gen 77
    emitter.emit({
      journey: 'JOURNEY_A_DISCOVERY',
      discoveryCycleId: 'disc-chaos-1',
      approvalGeneration: 77,
      stage: 2,
      tier: 'TIER_2',
      stageSeq: 1,
      eventType: 'TICKER_REJECTED',
      status: 'SKIPPED',
      symbol: 'DOGE/USDT',
      component: 'MarketOpportunityScanner',
      message: 'Rejected DOGE/USDT below minimum notional',
      emittedAtMs: t0 + 100,
      outputSummary: { eligible: false, rejectionReason: 'MIN_NOTIONAL_UNMET' },
    });
    emitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-chaos',
      botId: 'bot-chaos',
      discoveryCycleId: 'disc-chaos-1',
      parentApprovalGeneration: 77,
      cycleId: 'cyc-chaos-1',
      traceId: 'tr-chaos-1',
      stage: 4,
      tier: 'TIER_2',
      stageSeq: 2,
      eventType: 'TA_COMPUTED',
      status: 'PASS',
      symbol: 'DOGE/USDT',
      timeframe: '15m',
      component: 'IndicatorEngine',
      message: 'Leaked DOGE/USDT indicator computation after Stage 2 rejection',
      emittedAtMs: t0 + 200,
      outputSummary: { barCount: 50, rsi: 55.1 },
    });

    // Stage 3 stale candle failure (creates incident #2 alongside Stage 1 HTTP 500) + Stage 3/4 <20 bars SKIPPED -> MUST remain SQL NULL (anti-fabrication)
    emitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-chaos',
      botId: 'bot-chaos',
      cycleId: 'cyc-chaos-1',
      traceId: 'tr-chaos-1',
      stage: 3,
      tier: 'TIER_2',
      stageSeq: 3,
      eventType: 'CANDLE_VALIDATION_FAILED',
      status: 'FAIL',
      severity: 'ERROR',
      errorCode: 'STALE_CANDLES',
      symbol: 'ETH/USDT',
      timeframe: '15m',
      component: 'CandleValidator',
      message: 'ETH/USDT 15m candles stale (>2 intervals old)',
      emittedAtMs: t0 + 280,
      outputSummary: { stale: true, candleCount: 8 },
    });
    emitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-chaos',
      botId: 'bot-chaos',
      cycleId: 'cyc-chaos-1',
      traceId: 'tr-chaos-1',
      stage: 4,
      tier: 'TIER_2',
      stageSeq: 4,
      eventType: 'TA_COMPUTED',
      status: 'SKIPPED',
      severity: 'WARNING',
      symbol: 'ETH/USDT',
      timeframe: '15m',
      component: 'IndicatorEngine',
      message: 'Skipped TA: only 8 closed bars (<20 minimum)',
      emittedAtMs: t0 + 300,
      outputSummary: { barCount: 8, skipReason: 'INSUFFICIENT_BARS' },
    });

    // Stage 6 shadow divergence
    emitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-chaos',
      botId: 'bot-chaos',
      cycleId: 'cyc-chaos-1',
      traceId: 'tr-chaos-1',
      stage: 6,
      tier: 'TIER_2',
      stageSeq: 4,
      eventType: 'SIGNAL_LIFECYCLE_DECISION',
      status: 'WARN',
      severity: 'WARNING',
      symbol: 'SOL/USDT',
      strategyId: 'Breakout',
      timeframe: '15m',
      alertId: 'alt-ack-only',
      component: 'SignalLifecycleManager',
      message: 'Shadow rejected signal due to cooldown',
      emittedAtMs: t0 + 400,
      outputSummary: { liveDecision: 'PROMOTE', shadowDecision: 'REJECT_COOLDOWN', diverged: true, shadowOnly: true },
    });

    // Stage 7 Ack-only order (never fill-confirmed)
    emitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-chaos',
      botId: 'bot-chaos',
      cycleId: 'cyc-chaos-1',
      traceId: 'tr-chaos-1',
      stage: 7,
      tier: 'TIER_1',
      stageSeq: 5,
      eventType: 'ORDER_SUBMIT_DISPATCHED',
      status: 'PASS',
      symbol: 'SOL/USDT',
      alertId: 'alt-ack-only',
      intentId: 'int-ack-only',
      clientOrderId: 'cl-ack-only',
      component: 'BybitAdapter.createOrder',
      message: 'Submitted order for SOL/USDT',
      emittedAtMs: t0 + 500,
    });
    emitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-chaos',
      botId: 'bot-chaos',
      cycleId: 'cyc-chaos-1',
      traceId: 'tr-chaos-1',
      stage: 7,
      tier: 'TIER_1',
      stageSeq: 6,
      eventType: 'BYBIT_HTTP_ACK',
      status: 'PASS',
      symbol: 'SOL/USDT',
      alertId: 'alt-ack-only',
      intentId: 'int-ack-only',
      clientOrderId: 'cl-ack-only',
      orderId: 'ord-ack-only',
      component: 'BybitAdapter.createOrder',
      message: 'HTTP Ack open; fill still pending',
      emittedAtMs: t0 + 600,
      outputSummary: { httpStatus: 200, orderId: 'ord-ack-only', status: 'open', filled: 0 },
    });

    // Stage 8 -> 9 mismatch (alt-mismatch) + suppressed precheck (alt-suppressed)
    emitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-chaos',
      cycleId: 'cyc-chaos-1',
      traceId: 'tr-chaos-1',
      stage: 8,
      tier: 'TIER_1',
      stageSeq: 7,
      eventType: 'FCM_DISPATCH_ATTEMPTED',
      status: 'PASS',
      symbol: 'AVAX/USDT',
      strategyId: 'Breakout',
      timeframe: '15m',
      alertId: 'alt-mismatch',
      fcmMessageId: 'fcm-mismatch',
      component: 'notifications.sendFcm',
      message: 'Sent Breakout 15m push',
      emittedAtMs: t0 + 700,
      outputSummary: { success: true, strategyId: 'Breakout', timeframe: '15m' },
    });
    emitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-chaos',
      stage: 9,
      tier: 'TIER_1',
      stageSeq: 8,
      eventType: 'ANDROID_NOTIFICATION_POST_CHECK',
      status: 'WARN',
      severity: 'WARNING',
      symbol: 'AVAX/USDT',
      strategyId: 'Momentum',
      timeframe: '5m',
      alertId: 'alt-mismatch',
      component: 'TradeAlertManager.postSystemNotification',
      message: 'Notification missing in activeNotifications',
      emittedAtMs: t0 + 750,
      outputSummary: {
        notificationsEnabled: true,
        channelImportance: 4,
        notifySucceeded: true,
        postNotifyVerified: false,
        androidOsHeadsUpState: 'POST_CHECK_MISSING',
      },
    });
    emitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-chaos',
      stage: 9,
      tier: 'TIER_1',
      stageSeq: 9,
      eventType: 'ANDROID_POPUP_RENDERED',
      status: 'PASS',
      symbol: 'AVAX/USDT',
      strategyId: 'Momentum',
      timeframe: '5m',
      alertId: 'alt-mismatch',
      component: 'TradeAlertScreen',
      message: 'Rendered mismatched strategy',
      emittedAtMs: t0 + 800,
      outputSummary: {
        rendered: true,
        renderedFields: { symbol: 'AVAX/USDT', strategyId: 'Momentum', timeframe: '5m' },
      },
    });

    emitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-chaos',
      stage: 8,
      tier: 'TIER_1',
      stageSeq: 10,
      eventType: 'FCM_DISPATCH_ATTEMPTED',
      status: 'PASS',
      symbol: 'LINK/USDT',
      strategyId: 'VWAP',
      timeframe: '5m',
      alertId: 'alt-suppressed',
      fcmMessageId: 'fcm-suppressed',
      component: 'notifications.sendFcm',
      message: 'Sent VWAP 5m push',
      emittedAtMs: t0 + 900,
      outputSummary: { success: true, strategyId: 'VWAP', timeframe: '5m' },
    });
    emitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-chaos',
      stage: 9,
      tier: 'TIER_1',
      stageSeq: 11,
      eventType: 'ANDROID_NOTIFICATION_PRECHECK',
      status: 'WARN',
      severity: 'WARNING',
      symbol: 'LINK/USDT',
      strategyId: 'VWAP',
      timeframe: '5m',
      alertId: 'alt-suppressed',
      component: 'TradeAlertManager.postSystemNotification',
      message: 'Notifications disabled by OS user preference',
      emittedAtMs: t0 + 950,
      outputSummary: {
        notificationsEnabled: false,
        channelEnabled: true,
        channelImportance: 4,
        androidOsHeadsUpState: 'SUPPRESSED_PRECHECK',
      },
    });
    emitter.emit({
      journey: 'JOURNEY_B_AUTONOMOUS',
      userId: 'user-chaos',
      stage: 9,
      tier: 'TIER_1',
      stageSeq: 12,
      eventType: 'ANDROID_NOTIFICATION_POST_CHECK',
      status: 'WARN',
      severity: 'WARNING',
      symbol: 'LINK/USDT',
      strategyId: 'VWAP',
      timeframe: '5m',
      alertId: 'alt-suppressed',
      component: 'TradeAlertManager.postSystemNotification',
      message: 'Post-check remained suppressed',
      emittedAtMs: t0 + 960,
      outputSummary: {
        notificationsEnabled: false,
        notifySucceeded: true,
        postNotifyVerified: false,
        androidOsHeadsUpState: 'SUPPRESSED_PRECHECK',
      },
    });

    await emitter.flush();
    await deliverAllEnvelopes(sentBatches.flat(), env);

    // Anti-fabrication: ETH/USDT SKIPPED TA MUST store strict SQL NULLs
    const taEth = await apiGet(env, jwt, '/api/monitor/v2/ta?symbol=ETH/USDT');
    expect(taEth.status).toBe(200);
    expect(taEth.body.items[0].status).toBe('SKIPPED');
    expect(taEth.body.items[0].rsi).toBeNull();
    expect(taEth.body.items[0].ema9).toBeNull();
    expect(taEth.body.items[0].ema21).toBeNull();
    expect(taEth.body.items[0].atr).toBeNull();
    expect(taEth.body.items[0].vwap).toBeNull();

    // Stage 2 leak detected cleanly
    const overview = await apiGet(env, jwt, '/api/monitor/v2/overview');
    const taAll = await apiGet(env, jwt, '/api/monitor/v2/ta');
    expect(overview.body.journeys?.stage2Summary?.leakedCount).toBeGreaterThanOrEqual(1);
    expect(taAll.body.stage2LeakCheck?.downstreamLeakedCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(taAll.body.stage2LeakCheck?.leakedSamples)).toContain('DOGE/USDT');

    // Stage 7 Ack-only MUST NOT report FILL_CONFIRMED
    const trades = await apiGet(env, jwt, '/api/monitor/v2/trades');
    expect(trades.body.items.length).toBe(1);
    expect(trades.body.items[0].executionStatus).toBe('BYBIT_ACKED');
    expect(trades.body.items[0].isAckOnly).toBe(true);
    expect(trades.body.items[0].hasFillConfirmation).toBe(false);

    // Stage 8 -> 9 mismatch & suppressed precheck visibility
    const notifs = await apiGet(env, jwt, '/api/monitor/v2/notifications');
    const byAlert = new Map<string, any>(notifs.body.items.map((n: any) => [n.alertId, n]));
    expect(byAlert.get('alt-mismatch')?.parityStatus).toBe('PARITY_MISMATCH');
    expect(byAlert.get('alt-mismatch')?.androidOsHeadsUpState).toBe('POST_CHECK_MISSING');
    expect(byAlert.get('alt-suppressed')?.androidOsHeadsUpState).toBe('SUPPRESSED_PRECHECK');

    // Stage 6 shadow divergence surfaced via strategies-gates
    const stratChaos = await apiGet(env, jwt, '/api/monitor/v2/strategies-gates');
    expect(stratChaos.status).toBe(200);
    const divergedGate = (stratChaos.body.gateEvaluations as any[]).find(
      (g) => g.traceId === 'tr-chaos-1' && g.gateName === 'SignalLifecycleManager'
    );
    expect(divergedGate?.outputs?.diverged).toBe(true);
    expect(divergedGate?.outputs?.shadowDecision).toBe('REJECT_COOLDOWN');

    // Incidents surfaced (including Stage 1 HTTP 500 + Stage 3 STALE_CANDLES)
    const incidents = await apiGet(env, jwt, '/api/monitor/v2/incidents');
    expect(incidents.status).toBe(200);
    expect(incidents.body.items.length).toBeGreaterThanOrEqual(2);
    const firstInc = incidents.body.items[0];
    expect(firstInc.fingerprint).toBeTruthy();
    const incDetail = await apiGet(env, jwt, `/api/monitor/v2/incidents/${firstInc.fingerprint}`);
    expect(incDetail.status).toBe(200);
  });

  it('survives complete producer queue + fallback outage and surfaces D1 failure -> retry() -> DLQ -> self-health cleanly', async () => {
    const db = new SqliteD1Database();
    const env = createEnv(db);
    const jwt = await signAdminJwt(env.JWT_SECRET!);

    // 1. Producer resilience under total monitoring outage
    const failingEmitter = new TelemetryEmitter({
      producer: 'trading-bot-do',
      queue: {
        async send() {
          throw new Error('QUEUE_OUTAGE');
        },
        async sendBatch() {
          throw new Error('QUEUE_BATCH_OUTAGE');
        },
      },
      httpFallback: {
        async fetch() {
          return new Response('Service Unavailable', { status: 503 });
        },
      },
      maxBufferSize: 5,
      maxBatchSize: 5,
    });

    for (let i = 0; i < 10; i++) {
      failingEmitter.emit({
        journey: 'JOURNEY_B_AUTONOMOUS',
        stage: 7,
        tier: 'TIER_1',
        eventType: 'ORDER_SUBMIT_DISPATCHED',
        status: 'PASS',
        component: 'BybitAdapter',
        message: `Simulated trading event ${i}`,
      });
    }
    const flushRes = await failingEmitter.flush();
    expect(flushRes.sentEvents).toBe(0);
    expect(flushRes.failedEvents).toBeGreaterThanOrEqual(1);
    const stats = failingEmitter.getHealthStats();
    expect(stats.queueSendFailed).toBeGreaterThanOrEqual(1);
    expect(stats.httpFallbackFailed).toBeGreaterThanOrEqual(1);
    expect(failingEmitter.getBufferedEventsSnapshot().length).toBeLessThanOrEqual(5);

    // 2. Consumer D1 fault -> retry() -> DLQ -> self-health alert
    const badEnvelope: TelemetryQueueEnvelope = {
      batchId: 'bat-dlq-e2e',
      producer: 'trading-bot-do',
      producedAtMs: Date.now(),
      events: [
        {
          schemaVersion: 2,
          spanId: 'spn-dlq-e2e',
          journey: 'JOURNEY_B_AUTONOMOUS',
          cycleId: 'CYC-DLQ-1',
          traceId: 'TRC-DLQ-1',
          stage: 7,
          tier: 'TIER_1',
          stageSeq: 1,
          eventType: 'ORDER_SUBMIT_DISPATCHED',
          status: 'PASS',
          severity: 'INFO',
          environment: 'mainnet',
          deliveryMilestone: 'QUEUE_SEND_ATTEMPTED',
          component: 'BybitAdapter',
          message: 'Will fail D1 write and hit DLQ',
          emittedAtMs: Date.now(),
        },
      ],
    };

    db.injectErrorOnMatch = {
      pattern: /INSERT.*INTO stage_spans/i,
      error: new Error('D1_WRITE_TIMEOUT'),
    };
    const qRes = await deliverAllEnvelopes([badEnvelope], env);
    expect(qRes.retried).toBe(1);
    expect(qRes.acked).toBe(0);

    // Move to DLQ once D1 recovers
    db.injectErrorOnMatch = null;
    await handleDlqBatch(
      {
        queue: 'cryptopulse-telemetry-dlq',
        messages: [
          {
            id: 'dlq-msg-1',
            timestamp: new Date(),
            body: badEnvelope,
            attempts: 3,
            ack: () => {},
            retry: () => {},
          },
        ],
        retryAll: () => {},
        ackAll: () => {},
      } as any,
      env
    );

    const selfHealth = await apiGet(env, jwt, '/api/monitor/v2/self-health');
    expect(selfHealth.status).toBe(200);
    expect(selfHealth.body.dlqSummary?.count).toBe(1);
    expect(selfHealth.body.recentDlqRecords[0].batchId).toBe('bat-dlq-e2e');
    expect(selfHealth.body.honestState).toBe('D1_ERRORS');
  });
});
