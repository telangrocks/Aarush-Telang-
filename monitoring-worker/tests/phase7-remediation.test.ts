import { describe, expect, it } from 'vitest';
import {
  ANDROID_DEDUP_DECISIONS,
  ANDROID_HEADSUP_STATES,
  ANDROID_VALIDATION_OUTCOMES,
  PARITY_STATUSES,
  STAGE9_CONTRACT_VERSION,
  STAGE9_EVENT_TYPES,
  TelemetryEmitter,
  computeIncidentFingerprint,
} from '../../shared/monitoring';
import { ingestEnvelope } from '../src/consumer';
import { handleMonitorFetch } from '../src/index';
import { MonitoringEnv } from '../src/types';
import { SqliteD1Database } from './helpers/sqliteD1';

async function signJwt(secret: string, payloadClaims: Record<string, unknown>): Promise<string> {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iat: nowSec,
      exp: nowSec + 3600,
      ...payloadClaims,
    })
  ).toString('base64url');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`));
  const sig = Buffer.from(sigBuf).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function createEnv(db: SqliteD1Database, backendFetch?: (url: string) => Response): MonitoringEnv {
  return {
    MONITORING_DB: db as unknown as D1Database,
    ENVIRONMENT: 'testnet',
    ALLOWED_ORIGINS: 'https://cryptopulse-monitoring.pages.dev',
    ADMIN_API_KEY: 'operator-secret-key',
    JWT_SECRET: 'remediation-jwt-secret',
    ADMIN_EMAILS: 'admin-list@example.com',
    BACKEND_SERVICE: backendFetch
      ? ({
          fetch: async (url: string) => backendFetch(url),
        } as any)
      : undefined,
  };
}

async function emitAndIngest(
  db: SqliteD1Database,
  producer: 'trading-bot-do' | 'public-market-coordinator' | 'crypto-pulse-backend' | 'android-app',
  emitFn: (emitter: TelemetryEmitter) => void
): Promise<void> {
  const batches: any[] = [];
  const emitter = new TelemetryEmitter({
    producer,
    queue: {
      send: async (env: any) => {
        batches.push(env);
      },
    },
    maxBufferSize: 200,
    maxBatchSize: 50,
  });
  emitFn(emitter);
  await emitter.flush();
  for (const batch of batches) {
    await ingestEnvelope(db as unknown as D1Database, batch);
  }
}

async function apiReq(
  env: MonitoringEnv,
  path: string,
  options: { method?: string; jwt?: string; adminKey?: string } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (options.jwt) headers.Authorization = `Bearer ${options.jwt}`;
  if (options.adminKey) headers['X-Admin-Key'] = options.adminKey;
  const res = await handleMonitorFetch(
    new Request(`https://monitor.local${path}`, {
      method: options.method || 'GET',
      headers,
    }),
    env
  );
  const body = await res.json();
  return { status: res.status, body };
}

describe('Phase 7: Defect Remediation Verification (Priorities 1-4)', () => {
  describe('Priority 1: Android Stage 9 Contract Alignment', () => {
    it('correlates positive canonical Stage 9 events cleanly and confirms entryPrice/SL/TP parity', async () => {
      const db = new SqliteD1Database();
      const env = createEnv(db);
      const t0 = Date.now() - 10_000;

      // Backend Stage 8 dispatch using outputSummary.price / stopLoss / takeProfit
      await emitAndIngest(db, 'crypto-pulse-backend', (emitter) => {
        emitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 8,
          eventType: 'NOTIFICATION_DISPATCHED',
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p1',
          traceId: 'tr-p1-ok',
          cycleId: 'cyc-p1-ok',
          alertId: 'alt-p1-ok',
          fcmMessageId: 'fcm-p1-ok',
          symbol: 'BTC/USDT',
          strategyId: 'MomentumV2',
          timeframe: '15m',
          emittedAtMs: t0,
          component: 'NotificationHandler',
          message: 'FCM sent',
          outputSummary: {
            fcmHttpStatus: 200,
            fcmDispatchStatus: 'SENT',
            price: 68500.25,
            stopLoss: 67200.0,
            takeProfit: 71000.0,
            isExecutable: true,
          },
        });
      });

      // Stage 9 FCM receipt ONLY must remain PENDING_ANDROID (never falsely PARITY_OK)
      await emitAndIngest(db, 'android-app', (emitter) => {
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.FCM_RECEIVED,
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p1',
          traceId: 'tr-p1-ok',
          alertId: 'alt-p1-ok',
          fcmMessageId: 'fcm-p1-ok',
          androidDeviceSessionHash: 'dev-hash-1',
          symbol: 'BTC/USDT',
          strategyId: 'MomentumV2',
          timeframe: '15m',
          emittedAtMs: t0 + 100,
          component: 'FcmService.onMessageReceived',
          message: 'FCM received',
        });
      });

      const jwtUserP1 = await signJwt(env.JWT_SECRET!, { sub: 'user-p1', role: 'ADMIN' });
      let res = await apiReq(env, '/api/monitor/v2/notifications?alertId=alt-p1-ok', { jwt: jwtUserP1 });
      expect(res.status).toBe(200);
      expect(res.body.items[0].parityStatus).toBe(PARITY_STATUSES.PENDING_ANDROID);
      expect(res.body.items[0].androidFcmReceivedAtMs).toBe(t0 + 100);

      // Hardware-suppressed dedup MUST still confirm PARITY_OK when popup subsequently renders via AlertBus
      await emitAndIngest(db, 'android-app', (emitter) => {
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.POLL_RECEIVED,
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p1',
          traceId: 'tr-p1-ok',
          alertId: 'alt-p1-ok',
          androidDeviceSessionHash: 'dev-hash-1',
          symbol: 'BTC/USDT',
          emittedAtMs: t0 + 150,
          component: 'BackgroundMonitoringService',
          message: 'Poll fallback also observed alert',
        });
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.DEDUP_DECISION,
          status: 'SKIPPED',
          severity: 'INFO',
          userId: 'user-p1',
          traceId: 'tr-p1-ok',
          alertId: 'alt-p1-ok',
          androidDeviceSessionHash: 'dev-hash-1',
          emittedAtMs: t0 + 200,
          component: 'TradeAlertManager',
          message: 'Hardware suppressed duplicate system notification',
          outputSummary: {
            decision: ANDROID_DEDUP_DECISIONS.SUPPRESSED,
            reason: 'DUPLICATE_ALERT_HARDWARE_SUPPRESSED',
          },
        });
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.NOTIFICATION_PRECHECK,
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p1',
          traceId: 'tr-p1-ok',
          alertId: 'alt-p1-ok',
          androidDeviceSessionHash: 'dev-hash-1',
          emittedAtMs: t0 + 250,
          component: 'TradeAlertManager',
          message: 'Precheck ok',
          outputSummary: {
            notificationsEnabled: true,
            channelEnabled: true,
            channelImportance: 4,
            headsUpEligible: true,
            androidOsHeadsUpState: ANDROID_HEADSUP_STATES.ELIGIBLE_OS_UNPROVABLE,
          },
        });
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.NOTIFICATION_POST_CHECK,
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p1',
          traceId: 'tr-p1-ok',
          alertId: 'alt-p1-ok',
          androidDeviceSessionHash: 'dev-hash-1',
          emittedAtMs: t0 + 300,
          component: 'TradeAlertManager',
          message: 'Post-check verified',
          outputSummary: {
            postNotifyVerified: true,
            androidOsHeadsUpState: ANDROID_HEADSUP_STATES.ELIGIBLE_OS_UNPROVABLE,
          },
        });
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.ALERT_VALIDATED,
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p1',
          traceId: 'tr-p1-ok',
          alertId: 'alt-p1-ok',
          androidDeviceSessionHash: 'dev-hash-1',
          emittedAtMs: t0 + 350,
          component: 'MainActivity.validateAlertData',
          message: 'Alert validated',
          outputSummary: { outcome: ANDROID_VALIDATION_OUTCOMES.PASS, reason: 'VALID' },
        });
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.POPUP_RENDERED,
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p1',
          traceId: 'tr-p1-ok',
          cycleId: 'cyc-p1-ok',
          alertId: 'alt-p1-ok',
          androidDeviceSessionHash: 'dev-hash-1',
          symbol: 'BTC/USDT',
          strategyId: 'MomentumV2',
          timeframe: '15m',
          emittedAtMs: t0 + 400,
          component: 'TradeAlertScreen',
          message: 'Popup rendered',
          outputSummary: {
            rendered: true,
            renderedFields: {
              symbol: 'BTC/USDT',
              strategyId: 'MomentumV2',
              timeframe: '15m',
              entryPrice: 68500.25,
              stopLossPrice: 67200.0,
              takeProfitPrice: 71000.0,
              isExecutable: true,
            },
          },
        });
      });

      res = await apiReq(env, '/api/monitor/v2/notifications?alertId=alt-p1-ok', { jwt: jwtUserP1 });
      const row = res.body.items[0];
      expect(row.parityStatus).toBe(PARITY_STATUSES.PARITY_OK);
      expect(row.parityMismatches).toEqual([]);
      expect(row.androidSource).toBe('BOTH');
      expect(row.androidOsHeadsUpState).toBe(ANDROID_HEADSUP_STATES.ELIGIBLE_OS_UNPROVABLE);
      expect(row.androidPostNotifyVerified).toBe(true);
      expect(row.androidRenderedAtMs).toBe(t0 + 400);

      const cycle = await db
        .prepare(`SELECT android_confirmed_count FROM pipeline_cycles WHERE cycle_id = 'cyc-p1-ok'`)
        .first<{ android_confirmed_count: number }>();
      expect(cycle?.android_confirmed_count).toBeGreaterThanOrEqual(1);
    });

    it('detects negative Stage 9 cases: entryPrice/SL/TP mismatches, postCheckMissing, rendered:false, TELEMETRY_FAILED, and dedup drop', async () => {
      const db = new SqliteD1Database();
      const env = createEnv(db);
      const t0 = Date.now() - 8_000;

      // 1. Price/SL/TP/executable mismatch
      await emitAndIngest(db, 'crypto-pulse-backend', (emitter) => {
        emitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 8,
          eventType: 'NOTIFICATION_DISPATCHED',
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-neg',
          traceId: 'tr-neg-1',
          alertId: 'alt-neg-1',
          symbol: 'ETH/USDT',
          strategyId: 'StratX',
          timeframe: '5m',
          emittedAtMs: t0,
          component: 'NotificationHandler',
          message: 'Sent',
          outputSummary: { price: 3200, stopLoss: 3100, takeProfit: 3400, isExecutable: true },
        });
      });
      await emitAndIngest(db, 'android-app', (emitter) => {
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.POPUP_RENDERED,
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-neg',
          traceId: 'tr-neg-1',
          alertId: 'alt-neg-1',
          symbol: 'ETH/USDT',
          emittedAtMs: t0 + 100,
          component: 'TradeAlertScreen',
          message: 'Mismatched render',
          outputSummary: {
            rendered: true,
            renderedFields: {
              symbol: 'ETH/USDT',
              entryPrice: 3299.5,
              stopLossPrice: 3050,
              takeProfitPrice: 3500,
              isExecutable: false,
            },
          },
        });
      });

      // 2. ANDROID_TELEMETRY_FAILED and rendered:false MUST NEVER mark android_confirmed_count or renderedAtMs
      await emitAndIngest(db, 'crypto-pulse-backend', (emitter) => {
        emitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 8,
          eventType: 'NOTIFICATION_DISPATCHED',
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-neg',
          traceId: 'tr-neg-2',
          cycleId: 'cyc-neg-2',
          alertId: 'alt-neg-2',
          symbol: 'SOL/USDT',
          emittedAtMs: t0,
          component: 'NotificationHandler',
          message: 'Sent',
          outputSummary: { price: 150 },
        });
      });
      await emitAndIngest(db, 'android-app', (emitter) => {
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.TELEMETRY_FAILED,
          status: 'WARN',
          severity: 'WARNING',
          userId: 'user-neg',
          traceId: 'tr-neg-2',
          cycleId: 'cyc-neg-2',
          alertId: 'alt-neg-2',
          emittedAtMs: t0 + 50,
          component: 'AndroidTelemetryClient',
          message: 'Upload failed transiently',
        });
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.POPUP_RENDERED,
          status: 'FAIL',
          severity: 'ERROR',
          userId: 'user-neg',
          traceId: 'tr-neg-2',
          cycleId: 'cyc-neg-2',
          alertId: 'alt-neg-2',
          emittedAtMs: t0 + 60,
          component: 'TradeAlertScreen',
          message: 'Render aborted',
          outputSummary: { rendered: false },
        });
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.NOTIFICATION_POST_CHECK,
          status: 'WARN',
          severity: 'WARNING',
          userId: 'user-neg',
          traceId: 'tr-neg-2',
          cycleId: 'cyc-neg-2',
          alertId: 'alt-neg-2',
          emittedAtMs: t0 + 70,
          component: 'TradeAlertManager',
          message: 'Notification missing after notify()',
          outputSummary: { postNotifyVerified: false, androidOsHeadsUpState: ANDROID_HEADSUP_STATES.POST_CHECK_MISSING },
        });
      });

      // 3. Dedup SUPPRESSED with NO popup render -> DROPPED_ON_ANDROID
      await emitAndIngest(db, 'crypto-pulse-backend', (emitter) => {
        emitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 8,
          eventType: 'NOTIFICATION_DISPATCHED',
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-neg',
          alertId: 'alt-neg-3',
          symbol: 'XRP/USDT',
          emittedAtMs: t0,
          component: 'NotificationHandler',
          message: 'Sent',
        });
      });
      await emitAndIngest(db, 'android-app', (emitter) => {
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.DEDUP_DECISION,
          status: 'SKIPPED',
          severity: 'INFO',
          userId: 'user-neg',
          alertId: 'alt-neg-3',
          emittedAtMs: t0 + 20,
          component: 'TradeAlertManager',
          message: 'Duplicate suppressed',
          outputSummary: { decision: ANDROID_DEDUP_DECISIONS.SUPPRESSED, reason: 'DUPLICATE_IN_MEMORY' },
        });
      });

      const jwt = await signJwt(env.JWT_SECRET!, { sub: 'user-neg', role: 'ADMIN' });
      const neg1 = await apiReq(env, '/api/monitor/v2/notifications?alertId=alt-neg-1', { jwt });
      expect(neg1.body.items[0].parityStatus).toBe(PARITY_STATUSES.PARITY_MISMATCH);
      expect(neg1.body.items[0].parityMismatches).toEqual(
        expect.arrayContaining([
          'FIELD_MISMATCH:entryPrice',
          'FIELD_MISMATCH:stopLossPrice',
          'FIELD_MISMATCH:takeProfitPrice',
          'FIELD_MISMATCH:isExecutable',
        ])
      );

      const neg2 = await apiReq(env, '/api/monitor/v2/notifications?alertId=alt-neg-2', { jwt });
      expect(neg2.body.items[0].androidRenderedAtMs).toBeNull();
      expect(neg2.body.items[0].parityStatus).toBe(PARITY_STATUSES.PARITY_MISMATCH);
      expect(neg2.body.items[0].parityMismatches).toContain('ANDROID_POST_CHECK_MISSING');

      const cycleNeg2 = await db
        .prepare(`SELECT android_confirmed_count FROM pipeline_cycles WHERE cycle_id = 'cyc-neg-2'`)
        .first<{ android_confirmed_count: number }>();
      expect(cycleNeg2?.android_confirmed_count).toBe(0);

      const neg3 = await apiReq(env, '/api/monitor/v2/notifications?alertId=alt-neg-3', { jwt });
      expect(neg3.body.items[0].parityStatus).toBe(PARITY_STATUSES.DROPPED_ON_ANDROID);
    });
  });

  describe('Priority 2: User and Device Isolation', () => {
    it('isolates all monitoring endpoints, overview counters, detail routes, live probe, and cross-device Stage 9 data', async () => {
      const db = new SqliteD1Database();
      const probedUrls: string[] = [];
      const env = createEnv(db, (url) => {
        probedUrls.push(url);
        return new Response(
          JSON.stringify({
            timestamp: Date.now(),
            worker: { environment: 'testnet' },
            d1Database: { status: 'HEALTHY' },
            publicMarketCoordinator: { secretInternalCacheSize: 99 },
            tradingBotState: { queriedUrl: url },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });
      const t0 = Date.now() - 5_000;

      // Global/system event (no userId) — must NOT leak to user-scoped overview
      await emitAndIngest(db, 'public-market-coordinator', (emitter) => {
        emitter.emit({
          journey: 'JOURNEY_A_DISCOVERY',
          discoveryCycleId: 'disc-global',
          approvalGeneration: 99,
          stage: 1,
          eventType: 'BYBIT_PUBLIC_FETCH',
          status: 'FAIL',
          severity: 'CRITICAL',
          symbol: 'GLOBAL/USDT',
          emittedAtMs: t0,
          component: 'PublicMarketDataCoordinator',
          errorCode: 'GLOBAL_ERR',
          message: 'Global background outage',
        });
      });

      // User A telemetry on Device A1 & Device A2
      await emitAndIngest(db, 'trading-bot-do', (emitter) => {
        const ctxA = { userId: 'user-a', botId: 'bot-a', journey: 'JOURNEY_B_AUTONOMOUS' as const, cycleId: 'cyc-a', traceId: 'tr-a' };
        emitter.emit({
          ...ctxA,
          stage: 4,
          eventType: 'TA_COMPUTED',
          status: 'PASS',
          severity: 'INFO',
          symbol: 'BTC/USDT',
          timeframe: '15m',
          emittedAtMs: t0 + 100,
          component: 'TAEngine',
          message: 'User A TA',
          outputSummary: { indicatorEngine: 'TA_CORE', rsi: 54 },
        });
        emitter.emit({
          ...ctxA,
          stage: 6,
          eventType: 'SAFETY_GATE_PASSED',
          status: 'PASS',
          severity: 'INFO',
          symbol: 'BTC/USDT',
          strategyId: 'ScalperA',
          timeframe: '15m',
          emittedAtMs: t0 + 150,
          component: 'SafetyGate',
          message: 'User A gate',
          outputSummary: { gateName: 'BudgetGate', gateCategory: 'RISK', decision: 'PASS' },
        });
        emitter.emit({
          ...ctxA,
          stage: 7,
          eventType: 'EXCHANGE_FILL_CONFIRMED',
          status: 'PASS',
          severity: 'INFO',
          symbol: 'BTC/USDT',
          orderId: 'ord-a',
          clientOrderId: 'cl-a',
          alertId: 'alt-shared',
          emittedAtMs: t0 + 200,
          component: 'TradingBot',
          message: 'User A fill',
          outputSummary: { filledQty: 0.1, avgPrice: 60000 },
        });
        emitter.emit({
          ...ctxA,
          stage: 8,
          eventType: 'NOTIFICATION_DISPATCHED',
          status: 'PASS',
          severity: 'INFO',
          symbol: 'BTC/USDT',
          alertId: 'alt-a-dev2',
          emittedAtMs: t0 + 220,
          component: 'NotificationHandler',
          message: 'User A alert for dev2',
        });
      });
      await emitAndIngest(db, 'android-app', (emitter) => {
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.POPUP_RENDERED,
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-a',
          traceId: 'tr-a',
          cycleId: 'cyc-a',
          alertId: 'alt-shared',
          androidDeviceSessionHash: 'dev-a1',
          symbol: 'BTC/USDT',
          emittedAtMs: t0 + 300,
          component: 'TradeAlertScreen',
          message: 'Rendered on dev-a1',
          outputSummary: { rendered: true, renderedFields: { symbol: 'BTC/USDT', entryPrice: 60000 } },
        });
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.POPUP_RENDERED,
          status: 'FAIL',
          severity: 'CRITICAL',
          userId: 'user-a',
          traceId: 'tr-a',
          cycleId: 'cyc-a',
          alertId: 'alt-a-dev2',
          androidDeviceSessionHash: 'dev-a2',
          symbol: 'BTC/USDT',
          emittedAtMs: t0 + 310,
          errorCode: 'DEV2_CRASH',
          component: 'TradeAlertScreen',
          message: 'Dev A2 error',
          outputSummary: { rendered: false },
        });
      });

      // User B telemetry (including same alertId='alt-shared' collision attempt!)
      const bFailEv = {
        journey: 'JOURNEY_B_AUTONOMOUS' as const,
        stage: 6 as const,
        eventType: 'SECRET_GATE_FAILED',
        status: 'FAIL' as const,
        severity: 'CRITICAL' as const,
        userId: 'user-b',
        botId: 'bot-b',
        cycleId: 'cyc-b',
        traceId: 'tr-b',
        symbol: 'SECRET/USDT',
        strategyId: 'SecretStratB',
        timeframe: '5m',
        emittedAtMs: t0 + 400,
        errorCode: 'SECRET_LEAK_B',
        component: 'SecretGateB',
        message: 'User B confidential failure',
      };
      await emitAndIngest(db, 'trading-bot-do', (emitter) => {
        const ctxB = { userId: 'user-b', botId: 'bot-b', journey: 'JOURNEY_B_AUTONOMOUS' as const, cycleId: 'cyc-b', traceId: 'tr-b' };
        emitter.emit({
          ...ctxB,
          stage: 2,
          eventType: 'TICKER_REJECTED',
          status: 'FAIL',
          severity: 'ERROR',
          symbol: 'SECRET/USDT',
          discoveryCycleId: 'disc-b',
          emittedAtMs: t0 + 350,
          component: 'Stage2Filter',
          message: 'User B rejected',
          outputSummary: { eligible: false, decisionOutcome: 'REJECTED', downstreamLeaked: true },
        });
        emitter.emit({
          ...ctxB,
          stage: 4,
          eventType: 'TA_COMPUTED',
          status: 'PASS',
          severity: 'INFO',
          symbol: 'SECRET/USDT',
          timeframe: '5m',
          discoveryCycleId: 'disc-b',
          emittedAtMs: t0 + 360,
          component: 'TAEngine',
          message: 'User B leaked TA',
          outputSummary: { indicatorEngine: 'TA_CORE', rsi: 77 },
        });
        emitter.emit(bFailEv);
        emitter.emit({
          ...ctxB,
          stage: 7,
          eventType: 'EXCHANGE_FILL_CONFIRMED',
          status: 'PASS',
          severity: 'INFO',
          symbol: 'SECRET/USDT',
          orderId: 'ord-b',
          clientOrderId: 'cl-b',
          alertId: 'alt-shared',
          emittedAtMs: t0 + 420,
          component: 'TradingBot',
          message: 'User B fill',
        });
        emitter.emit({
          ...ctxB,
          stage: 8,
          eventType: 'NOTIFICATION_DISPATCHED',
          status: 'PASS',
          severity: 'INFO',
          symbol: 'SECRET/USDT',
          alertId: 'alt-shared',
          emittedAtMs: t0 + 430,
          component: 'NotificationHandler',
          message: 'User B notification',
        });
      });

      const bIncidentFp = computeIncidentFingerprint(bFailEv as any);
      const jwtUserA = await signJwt(env.JWT_SECRET!, { sub: 'user-a', role: 'ADMIN' });
      const jwtUserA_Dev1 = await signJwt(env.JWT_SECRET!, {
        sub: 'user-a',
        role: 'ADMIN',
        androidDeviceSessionHash: 'dev-a1',
      });
      const jwtAdminEmailSpoof = await signJwt(env.JWT_SECRET!, {
        sub: 'user-a',
        email: 'admin-list@example.com',
        role: 'USER',
        monitoringScope: 'OPERATOR', // must NOT elevate because sub !== admin_operator/admin_device_owner
      });

      // Parameter tampering (?userId=user-b or ?deviceSessionHash=dev-a2) MUST return 403
      for (const path of [
        '/api/monitor/v2/overview?userId=user-b',
        '/api/monitor/v2/traces?userId=user-b',
        '/api/monitor/v2/ta?userId=user-b',
        '/api/monitor/v2/strategies-gates?userId=user-b',
        '/api/monitor/v2/trades?userId=user-b',
        '/api/monitor/v2/notifications?userId=user-b',
        '/api/monitor/v2/incidents?userId=user-b',
        '/api/monitor/v2/self-health?userId=user-b',
        '/api/monitor/v2/live-probe?userId=user-b',
        '/api/monitor/v2/notifications?deviceSessionHash=dev-a2',
      ]) {
        const token = path.includes('deviceSessionHash') ? jwtUserA_Dev1 : jwtUserA;
        const denied = await apiReq(env, path, { jwt: token });
        expect(denied.status).toBe(403);
      }

      // Spoofed email-admin with monitoringScope: 'OPERATOR' must still be USER_SCOPED (403 on user-b)
      const spoofDenied = await apiReq(env, '/api/monitor/v2/overview?userId=user-b', { jwt: jwtAdminEmailSpoof });
      expect(spoofDenied.status).toBe(403);

      // Overview for User A must NOT expose User B failures or unscoped GLOBAL error
      const ovA = await apiReq(env, '/api/monitor/v2/overview', { jwt: jwtUserA });
      expect(ovA.status).toBe(200);
      expect(ovA.body.overallVerdict).not.toBe('DISCONNECTED');
      expect(ovA.body.selfHealth.honestState).toBe('SCOPED_REDACTED');
      const serializedOvA = JSON.stringify(ovA.body);
      expect(serializedOvA).not.toContain('GLOBAL_ERR');
      expect(serializedOvA).not.toContain('SECRET/USDT');
      expect(serializedOvA).not.toContain('user-b');
      expect(serializedOvA).not.toContain('SECRET_LEAK_B');

      // Direct ID probing for User B trace, trade, and incident MUST return 404
      expect((await apiReq(env, '/api/monitor/v2/traces/tr-b', { jwt: jwtUserA })).status).toBe(404);
      expect((await apiReq(env, '/api/monitor/v2/trades/ord-b', { jwt: jwtUserA })).status).toBe(404);
      expect((await apiReq(env, `/api/monitor/v2/incidents/${bIncidentFp}`, { jwt: jwtUserA })).status).toBe(404);

      // List queries for User A must strictly exclude User B rows & User B leaked Stage 2 samples
      const taA = await apiReq(env, '/api/monitor/v2/ta', { jwt: jwtUserA });
      expect(taA.body.items.every((i: any) => i.symbol !== 'SECRET/USDT')).toBe(true);
      expect(taA.body.stage2LeakCheck.leakedSamples).toHaveLength(0);

      const gatesA = await apiReq(env, '/api/monitor/v2/strategies-gates', { jwt: jwtUserA });
      expect(JSON.stringify(gatesA.body)).not.toContain('SecretStratB');

      const tradesA = await apiReq(env, '/api/monitor/v2/trades', { jwt: jwtUserA });
      expect(tradesA.body.items.map((t: any) => t.orderId)).toEqual(['ord-a']);

      // User B's alt-shared must NOT corrupt User A's alt-shared parity row
      const notifsA = await apiReq(env, '/api/monitor/v2/notifications', { jwt: jwtUserA });
      expect(notifsA.body.items.every((n: any) => n.symbol !== 'SECRET/USDT')).toBe(true);

      const selfA = await apiReq(env, '/api/monitor/v2/self-health', { jwt: jwtUserA });
      expect(selfA.body.scopedToUser).toBe(true);
      expect(selfA.body.honestState).toBe('SCOPED_REDACTED');
      expect(selfA.body.recentDlqRecords).toEqual([]);
      expect(selfA.body.tableCounts.trades).toBe(1);

      const probeA = await apiReq(env, '/api/monitor/v2/live-probe', { jwt: jwtUserA });
      expect(probeA.status).toBe(200);
      expect(probeA.body.requestedUserId).toBe('user-a');
      expect(probeA.body.coordinatorStats).toBeNull();
      expect(probedUrls[0]).toContain('userId=user-a');

      // Cross-device isolation for User A Dev 1: must NOT see Dev 2 Stage 9 crash, notifications, or incidents
      const notifsDev1 = await apiReq(env, '/api/monitor/v2/notifications', { jwt: jwtUserA_Dev1 });
      expect(notifsDev1.body.items.map((n: any) => n.alertId)).toEqual(['alt-shared']);

      const incsDev1 = await apiReq(env, '/api/monitor/v2/incidents', { jwt: jwtUserA_Dev1 });
      expect(JSON.stringify(incsDev1.body)).not.toContain('DEV2_CRASH');

      const traceADev1 = await apiReq(env, '/api/monitor/v2/traces/tr-a', { jwt: jwtUserA_Dev1 });
      const stage9Hashes = traceADev1.body.spans
        .filter((s: any) => s.stage === 9)
        .map((s: any) => s.androidDeviceSessionHash);
      expect(stage9Hashes).toEqual(['dev-a1']);

      // Operator with X-Admin-Key still sees global view & can inspect either user
      const opAll = await apiReq(env, '/api/monitor/v2/trades', { adminKey: 'operator-secret-key' });
      expect(opAll.body.total).toBe(2);
    });
  });

  describe('Priority 3 & Priority 4: Canonical Parity Aggregation & Read-Only Method Guard', () => {
    it('aggregates empty, single-event, and mixed-event notification parity statuses without MATCHED/MISMATCH drift', async () => {
      const db = new SqliteD1Database();
      const env = createEnv(db);
      const jwt = await signJwt(env.JWT_SECRET!, { sub: 'user-p3', role: 'ADMIN' });

      // Empty state
      const emptyRes = await apiReq(env, '/api/monitor/v2/notifications', { jwt });
      expect(emptyRes.status).toBe(200);
      expect(emptyRes.body.summary).toMatchObject({
        total: 0,
        parityOkCount: 0,
        parityMismatchCount: 0,
        matchedCount: 0,
        mismatchCount: 0,
        pendingAndroidCount: 0,
        pendingBackendCount: 0,
        droppedOnAndroidCount: 0,
        fcmFailedCount: 0,
      });

      const t0 = Date.now() - 5_000;
      // Single PARITY_OK event
      await emitAndIngest(db, 'crypto-pulse-backend', (emitter) => {
        emitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 8,
          eventType: 'NOTIFICATION_DISPATCHED',
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p3',
          alertId: 'alt-1',
          emittedAtMs: t0,
          component: 'NotificationHandler',
          message: 'ok',
          outputSummary: { price: 100 },
        });
      });
      await emitAndIngest(db, 'android-app', (emitter) => {
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.POPUP_RENDERED,
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p3',
          alertId: 'alt-1',
          emittedAtMs: t0 + 10,
          component: 'TradeAlertScreen',
          message: 'rendered',
          outputSummary: { rendered: true, renderedFields: { entryPrice: 100 } },
        });
      });

      const singleRes = await apiReq(env, '/api/monitor/v2/notifications', { jwt });
      expect(singleRes.body.summary).toMatchObject({
        total: 1,
        parityOkCount: 1,
        matchedCount: 1,
        parityMismatchCount: 0,
        mismatchCount: 0,
      });

      // Mixed state: add MISMATCH, PENDING_ANDROID, PENDING_BACKEND, DROPPED_ON_ANDROID, FCM_FAILED
      await emitAndIngest(db, 'crypto-pulse-backend', (emitter) => {
        emitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 8,
          eventType: 'NOTIFICATION_DISPATCHED',
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p3',
          alertId: 'alt-2',
          emittedAtMs: t0,
          component: 'NotificationHandler',
          message: 'sent',
          outputSummary: { price: 200 },
        });
        emitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 8,
          eventType: 'NOTIFICATION_DISPATCHED',
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p3',
          alertId: 'alt-3',
          emittedAtMs: t0,
          component: 'NotificationHandler',
          message: 'pending',
        });
        emitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 8,
          eventType: 'NOTIFICATION_DISPATCHED',
          status: 'FAIL',
          severity: 'ERROR',
          userId: 'user-p3',
          alertId: 'alt-4',
          emittedAtMs: t0,
          component: 'NotificationHandler',
          message: 'fcm failed',
          outputSummary: { fcmHttpStatus: 500, fcmDispatchStatus: 'FAILED' },
        });
        emitter.emit({
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 8,
          eventType: 'NOTIFICATION_DISPATCHED',
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p3',
          alertId: 'alt-5',
          emittedAtMs: t0,
          component: 'NotificationHandler',
          message: 'dropped',
        });
      });
      await emitAndIngest(db, 'android-app', (emitter) => {
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.POPUP_RENDERED,
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p3',
          alertId: 'alt-2',
          emittedAtMs: t0 + 20,
          component: 'TradeAlertScreen',
          message: 'mismatch price',
          outputSummary: { rendered: true, renderedFields: { entryPrice: 250 } },
        });
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.NOTIFICATION_PRECHECK,
          status: 'WARN',
          severity: 'WARNING',
          userId: 'user-p3',
          alertId: 'alt-5',
          emittedAtMs: t0 + 20,
          component: 'TradeAlertManager',
          message: 'precheck suppressed',
          outputSummary: { notificationsEnabled: false, channelEnabled: true },
        });
        emitter.emit({
          contractVersion: STAGE9_CONTRACT_VERSION,
          journey: 'JOURNEY_B_AUTONOMOUS',
          stage: 9,
          eventType: STAGE9_EVENT_TYPES.FCM_RECEIVED,
          status: 'PASS',
          severity: 'INFO',
          userId: 'user-p3',
          alertId: 'alt-6',
          emittedAtMs: t0 + 20,
          component: 'FcmService',
          message: 'android arrived before backend',
        });
      });

      const mixedRes = await apiReq(env, '/api/monitor/v2/notifications', { jwt });
      expect(mixedRes.body.summary).toMatchObject({
        total: 6,
        parityOkCount: 1,
        parityMismatchCount: 1,
        matchedCount: 1,
        mismatchCount: 1,
        pendingAndroidCount: 1,
        pendingBackendCount: 1,
        droppedOnAndroidCount: 1,
        fcmFailedCount: 1,
      });
    });

    it('rejects all HTTP write methods on /api/monitor/v2/* with 405 Method Not Allowed', async () => {
      const db = new SqliteD1Database();
      const env = createEnv(db);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        for (const path of [
          '/api/monitor/v2/overview',
          '/api/monitor/v2/incidents/fp-123/status',
          '/api/monitor/v2/trades/ord-1',
        ]) {
          const res = await apiReq(env, path, { method, adminKey: 'operator-secret-key' });
          expect(res.status).toBe(405);
        }
      }
    });

    it('applies 0001 and 0002 D1 migrations cleanly in sequence and creates all tenant-scoping indexes', async () => {
      const db = new SqliteD1Database();
      const cycleCols = await db.prepare(`PRAGMA table_info(pipeline_cycles)`).all<{ name: string }>();
      expect((cycleCols.results || []).map((c) => c.name)).toContain('updated_at_ms');

      const exchCols = await db.prepare(`PRAGMA table_info(exchange_health_windows)`).all<{ name: string }>();
      expect((exchCols.results || []).map((c) => c.name)).toContain('user_id');

      const incCols = await db.prepare(`PRAGMA table_info(data_quality_incidents)`).all<{ name: string }>();
      expect((incCols.results || []).map((c) => c.name)).toEqual(
        expect.arrayContaining(['user_id', 'android_device_session_hash'])
      );

      const expectedIndexes: Array<[string, string]> = [
        ['pipeline_cycles', 'idx_cycles_user_updated'],
        ['stage_spans', 'idx_spans_user_time'],
        ['stage_spans', 'idx_spans_user_device'],
        ['stage2_eligibility_decisions', 'idx_s2_user_time'],
        ['ta_indicator_snapshots', 'idx_ta_user_time'],
        ['gate_evaluations', 'idx_gate_user_time'],
        ['trade_lifecycle_ledger', 'idx_trade_user_updated'],
        ['notification_parity_ledger', 'idx_notif_user_device'],
        ['exchange_health_windows', 'idx_exch_user_time'],
        ['data_quality_incidents', 'idx_inc_user_last'],
        ['data_quality_incidents', 'idx_inc_user_device'],
      ];

      for (const [tableName, indexName] of expectedIndexes) {
        const idxRows = await db.prepare(`PRAGMA index_list(${tableName})`).all<{ name: string }>();
        expect((idxRows.results || []).map((r) => r.name)).toContain(indexName);
      }
    });
  });
});
