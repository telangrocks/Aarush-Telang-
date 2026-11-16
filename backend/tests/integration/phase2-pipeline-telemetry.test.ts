import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { FORBIDDEN_TELEMETRY_KEYS, PipelineTelemetryEvent } from '../../../shared/monitoring';
import {
  bindTelemetryEnv,
  createScopedTelemetryEmitter,
  runWithTelemetryContext,
} from '../../src/infrastructure/monitoring/PipelineTelemetry';
import { MarketOpportunityScanner } from '../../src/engine/scanner/MarketOpportunityScanner';
import { ExchangeRequestScheduler, RequestPriority } from '../../src/infrastructure/exchange/pacing/ExchangeRequestScheduler';
import { PublicMarketDataService } from '../../src/infrastructure/market-data/PublicMarketDataService';
import { ReconciliationEngine } from '../../src/engine/reconciliation/ReconciliationEngine';
import { sendTradeNotification, sendTradeFillNotification } from '../../src/handlers/notifications';
import {
  handleReportClientIncident,
  resetClientTelemetryLimiterForTesting,
} from '../../src/handlers/admin-monitoring';
import { TradingBot } from '../../src/trading-bot';
import { ExchangeManager } from '../../src/exchanges';
import { IExchangeProvider } from '../../src/exchanges/IExchangeProvider';
import { ICandleProvider } from '../../src/infrastructure/exchange/types';
import { CandleValidator } from '../../src/infrastructure/exchange/CandleValidator';
import { ScannerTimeframe } from '../../src/engine/scanner/MultiTimeframeCandleStore';

vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('mocked_decrypted_secret_never_logged'),
}));

vi.mock('../../src/exchanges', async (importOriginal) => {
  const actual: any = await importOriginal();
  const makeCandles = (count = 205, tfMs = 300_000) => {
    const now = Date.now();
    const baseTime = now - count * tfMs;
    return Array.from({ length: count }, (_, i) => {
      const p = 100 + i * 0.25;
      return {
        timestamp: baseTime + i * tfMs,
        openTime: baseTime + i * tfMs,
        closeTime: baseTime + (i + 1) * tfMs,
        open: p - 0.1,
        high: p + 0.5,
        low: p - 0.5,
        close: p,
        volume: 2500 + i * 15,
      };
    });
  };

  const mockOrderResponse = {
    id: 'bybit_ord_1001',
    clientOrderId: 'cli_ord_1001',
    symbol: 'BTC/USDT',
    type: 'market',
    side: 'buy',
    amount: 0.002,
    filled: 0.002,
    remaining: 0,
    price: 50000,
    average: 50000,
    status: 'closed',
    stopLoss: 49000,
    takeProfit: 52000,
  };

  const provider = {
    fetchTicker: vi.fn().mockImplementation(async (sym?: string) => {
      if (sym && sym.includes('ETH')) {
        return {
          symbol: 'ETH/USDT',
          last: 3000,
          bid: 2999,
          ask: 3001,
          high: 3050,
          low: 2950,
          volume: 20000,
          quoteVolume: 60_000_000,
        };
      }
      return {
        symbol: 'BTC/USDT',
        last: 50000,
        bid: 49995,
        ask: 50005,
        high: 51000,
        low: 49000,
        volume: 10000,
        quoteVolume: 500_000_000,
      };
    }),
    fetchTickers: vi.fn().mockResolvedValue([
      {
        symbol: 'BTC/USDT',
        last: 50000,
        bid: 49995,
        ask: 50005,
        high: 51000,
        low: 49000,
        volume: 10000,
        quoteVolume: 500_000_000,
        timestamp: Date.now(),
      },
    ]),
    fetchKlines: vi.fn().mockImplementation(async (sym: string, tf: string) => {
      // Return short candles for ETH/USDT on 4h to exercise insufficient bars anti-fabrication
      if (sym.includes('ETH') && tf === '4h') {
        return makeCandles(5, CandleValidator.timeframeToMs(tf as ScannerTimeframe));
      }
      return makeCandles(205, CandleValidator.timeframeToMs(tf as ScannerTimeframe));
    }),
    fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 1000 }, total: { USDT: 1000 } }),
    fetchMarkets: vi.fn().mockResolvedValue([
      {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        quote: 'USDT',
        active: true,
        category: 'linear',
        precision: { amount: 0.001, price: 0.1 },
        limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } },
      },
      {
        id: 'ETHUSDT',
        symbol: 'ETH/USDT',
        quote: 'USDT',
        active: true,
        category: 'linear',
        precision: { amount: 0.01, price: 0.1 },
        limits: { cost: { min: 5 }, amount: { min: 0.01, max: 1000 } },
      },
    ]),
    fetchMarket: vi.fn().mockImplementation(async (sym: string) => ({
      id: sym.replace('/', ''),
      symbol: sym,
      quote: 'USDT',
      active: true,
      category: 'linear',
      precision: { amount: 0.001, price: 0.1 },
      limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } },
    })),
    fetchPositions: vi.fn().mockImplementation(async (_cat?: string, sym?: string, includeEmpty?: boolean) => {
      if (includeEmpty) {
        return [{ symbol: sym || 'BTC/USDT', contracts: 0, size: 0, positionIdx: 0 }];
      }
      return [];
    }),
    fetchOrder: vi.fn().mockResolvedValue(mockOrderResponse),
    createOrder: vi.fn().mockResolvedValue(mockOrderResponse),
    setTradingStop: vi.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK' }),
  };

  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue(provider),
      executeIdempotentOrder: vi.fn().mockImplementation(async (p: any, req: any) => {
        if (typeof req.beforeOrderDispatch === 'function') {
          const release = await req.beforeOrderDispatch({ method: 'POST', path: '/v5/order/create', body: req });
          if (typeof release === 'function') release();
        }
        return provider.createOrder(req);
      }),
    },
    normalizeEnvironment: vi.fn().mockReturnValue('testnet'),
    normalizeRegion: vi.fn().mockReturnValue('global'),
  };
});

async function generateTestPemPrivateKey(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  let binary = '';
  for (let i = 0; i < pkcs8.length; i++) binary += String.fromCharCode(pkcs8[i]);
  const b64 = btoa(binary);
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}

function createMockDoState(initial: Record<string, any> = {}) {
  const storageMap = new Map<string, any>(Object.entries(initial));
  const pendingWaits: Promise<unknown>[] = [];
  const state: any = {
    id: { toString: () => 'do_bot_test_user_1' },
    waitUntil: (p: Promise<unknown>) => {
      pendingWaits.push(p);
    },
    storage: {
      get: async (k: string | string[]) => {
        if (Array.isArray(k)) {
          const m = new Map();
          for (const item of k) if (storageMap.has(item)) m.set(item, storageMap.get(item));
          return m;
        }
        return storageMap.get(k);
      },
      put: async (k: string | Record<string, any>, v?: any) => {
        if (typeof k === 'string') storageMap.set(k, v);
        else for (const [ek, ev] of Object.entries(k)) storageMap.set(ek, ev);
      },
      delete: async (k: string) => storageMap.delete(k),
      setAlarm: vi.fn(),
      list: async (opts?: any) => {
        if (opts?.prefix) {
          const m = new Map();
          for (const [k, v] of storageMap.entries()) if (k.startsWith(opts.prefix)) m.set(k, v);
          return m;
        }
        return storageMap;
      },
      transaction: async (cb: any) => cb(state.storage),
    },
    blockConcurrencyWhile: async (cb: any) => cb(),
    drainWaits: async () => {
      await Promise.allSettled(pendingWaits);
      pendingWaits.length = 0;
    },
    storageMap,
  };
  return state;
}

function createMockD1(fcmToken = 'fcm_device_token_secret_abc') {
  return {
    prepare: vi.fn().mockImplementation((q: string) => {
      if (q.includes('PRAGMA table_info')) {
        return {
          all: vi.fn().mockResolvedValue({
            results: [{ name: 'target_entry_price' }, { name: 'entry_status' }, { name: 'timeframe' }],
          }),
        };
      }
      return {
        bind: vi.fn().mockImplementation((..._args: any[]) => ({
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({ success: true }),
          first: vi.fn().mockImplementation(async () => {
            return {
              fcm_token: fcmToken,
              exchange_name: 'bybit',
              exchange_environment: 'testnet',
              exchange_region: 'global',
              exchange_api_key: 'test_api_key_redacted',
              exchange_api_key_encrypted: 'enc_key_redacted',
              exchange_api_key_iv: 'iv_1',
              exchange_api_secret_encrypted: 'enc_secret_redacted',
              exchange_api_secret_iv: 'iv_2',
            };
          }),
        })),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true }),
        first: vi.fn().mockResolvedValue(null),
      };
    }),
  };
}

describe('Phase 2 Pipeline Telemetry Integration (Stages 1-9)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    resetClientTelemetryLimiterForTesting();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('emits Journey A spans across Stage 1, Stage 2, and anti-fabrication Stage 4 TA', async () => {
    const envelopes: any[] = [];
    const env: any = {
      ENVIRONMENT: 'testnet',
      TELEMETRY_QUEUE: {
        send: vi.fn().mockImplementation(async (envelope: any) => {
          envelopes.push(envelope);
        }),
      },
    };
    const emitter = createScopedTelemetryEmitter('crypto-pulse-backend', env);
    bindTelemetryEnv(env);

    // Stage 1: PublicMarketDataService L3 fallback + ExchangeRequestScheduler yield check
    const mockPubData = new PublicMarketDataService(
      {
        PUBLIC_MARKET_DATA_COORDINATOR: {
          idFromName: () => ({ toString: () => 'coord-1' }),
          get: () => ({
            fetch: vi.fn().mockResolvedValue(
              new Response(JSON.stringify({ tickers: [{ symbol: 'BTC/USDT', last: 50000 }], ageMs: 400 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              })
            ),
          }),
        },
        ENVIRONMENT: 'testnet',
      } as any
    );

    const scheduler = new ExchangeRequestScheduler();
    await scheduler.schedule(RequestPriority.P3_BACKGROUND, () => Promise.resolve('ok'));

    const markets = [
      {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        category: 'linear',
        contractType: 'LinearPerpetual',
        limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } },
        precision: { price: 0.1, amount: 0.001 },
      },
      {
        id: 'TINYUSDT',
        symbol: 'TINY/USDT',
        base: 'TINY',
        quote: 'USDT',
        active: true,
        category: 'linear',
        contractType: 'LinearPerpetual',
        // Min notional 100 > budget 10 -> rejected at Stage 2
        limits: { cost: { min: 100 }, amount: { min: 10, max: 1000 } },
        precision: { price: 0.1, amount: 1 },
      },
      {
        id: 'ETHUSDT',
        symbol: 'ETH/USDT',
        base: 'ETH',
        quote: 'USDT',
        active: true,
        category: 'linear',
        contractType: 'LinearPerpetual',
        limits: { cost: { min: 5 }, amount: { min: 0.01, max: 1000 } },
        precision: { price: 0.1, amount: 0.01 },
      },
    ];

    const now = Date.now();
    const makeBars = (n: number, tfMs: number) =>
      Array.from({ length: n }, (_, i) => {
        const c = 100 + i * 0.5;
        return {
          timestamp: now - (n - i) * tfMs,
          openTime: now - (n - i) * tfMs,
          open: c - 0.1,
          high: c + 0.5,
          low: c - 0.5,
          close: c,
          volume: 10000 + i * 25,
        };
      });

    const scannerProvider = {
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockResolvedValue([
        { symbol: 'BTC/USDT', last: 50000, bid: 49999, ask: 50001, quoteVolume: 50_000_000, high: 51000, low: 49000, timestamp: now },
        { symbol: 'TINY/USDT', last: 1.5, bid: 1.499, ask: 1.501, quoteVolume: 25_000_000, high: 1.6, low: 1.4, timestamp: now },
        { symbol: 'ETH/USDT', last: 3000, bid: 2999, ask: 3001, quoteVolume: 30_000_000, high: 3050, low: 2950, timestamp: now },
      ]),
      fetchCandles: vi.fn().mockImplementation(async (sym: string, tf: string) => {
        // BTC/USDT gets full 60 bars (PASS SCANNER_SIMPLE), ETH/USDT gets < 20 bars on 1h (SKIPPED INSUFFICIENT_BARS)
        if (sym.includes('ETH') && tf === '1h') return makeBars(6, CandleValidator.timeframeToMs('1h'));
        return makeBars(60, CandleValidator.timeframeToMs(tf as ScannerTimeframe));
      }),
    } as unknown as IExchangeProvider & ICandleProvider;

    await runWithTelemetryContext(
      {
        journey: 'JOURNEY_A_DISCOVERY',
        discoveryCycleId: 'disc_test_1',
        environment: 'testnet',
        userId: 'user_1',
        emitter,
      },
      async () => {
        await mockPubData.getTickers('bybit', 'testnet');
        const scanner = new MarketOpportunityScanner(scannerProvider);
        await scanner.scan({ tradeAmountUsdt: 60 });
      }
    );
    await emitter.flush();

    const allEvents: PipelineTelemetryEvent[] = envelopes.flatMap((e) => e.events);
    expect(allEvents.length).toBeGreaterThan(0);

    const cacheEvent = allEvents.find((e) => e.stage === 1 && e.eventType === 'PUBLIC_MARKET_DATA_CACHE');
    expect(cacheEvent).toBeDefined();
    expect(cacheEvent?.journey).toBe('JOURNEY_A_DISCOVERY');
    expect(cacheEvent?.discoveryCycleId).toBe('disc_test_1');

    const eligible = allEvents.find((e) => e.stage === 2 && e.eventType === 'TICKER_ELIGIBLE' && e.symbol === 'BTC/USDT');
    const eligibleEth = allEvents.find((e) => e.stage === 2 && e.eventType === 'TICKER_ELIGIBLE' && e.symbol === 'ETH/USDT');
    const rejected = allEvents.find((e) => e.stage === 2 && e.eventType === 'TICKER_REJECTED' && e.symbol === 'TINY/USDT');
    const summary = allEvents.find((e) => e.stage === 2 && e.eventType === 'STAGE2_FILTER_SUMMARY');
    expect(eligible).toBeDefined();
    expect(eligibleEth).toBeDefined();
    expect(rejected).toBeDefined();
    expect(summary).toBeDefined();

    // Anti-fabrication: skipped Stage 4 snapshot must not carry numeric indicator values
    const skippedTa = allEvents.find((e) => e.stage === 4 && e.status === 'SKIPPED');
    const computedTa = allEvents.find((e) => e.stage === 4 && e.status === 'PASS');
    expect(skippedTa).toBeDefined();
    expect(skippedTa?.symbol).toBe('ETH/USDT');
    expect(skippedTa?.outputSummary?.rsi ?? null).toBeNull();
    expect(skippedTa?.outputSummary?.ema21 ?? null).toBeNull();
    expect(computedTa).toBeDefined();
    expect(computedTa?.symbol).toBe('BTC/USDT');
    expect(computedTa?.outputSummary?.indicatorEngine).toBe('SCANNER_SIMPLE');
  });

  it('emits Journey B alarm, execution milestones, Stage 8 FCM messageId, and Stage 9 client telemetry without secrets', async () => {
    const envelopes: any[] = [];
    const env: any = {
      ENVIRONMENT: 'testnet',
      GLOBAL_TRADING_HALT: 'false',
      ENCRYPTION_KEY: 'test-encryption-key',
      FCM_PROJECT_ID: 'cryptopulse-test',
      FCM_CLIENT_EMAIL: 'fcm@cryptopulse-test.iam.gserviceaccount.com',
      FCM_PRIVATE_KEY: await generateTestPemPrivateKey(),
      DB: createMockD1(),
      TELEMETRY_QUEUE: {
        send: vi.fn().mockImplementation(async (envelope: any) => {
          envelopes.push(envelope);
        }),
      },
    };
    bindTelemetryEnv(env);

    // 1. Mock fetch for Google OAuth + FCM v1 HTTP 200
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock_oauth_token_never_logged', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (String(url).includes('fcm.googleapis.com/v1')) {
        return new Response(JSON.stringify({ name: 'projects/cryptopulse-test/messages/msg_stage8_001' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    }) as any;

    const approvalExpiresAt = Date.now() + 3600_000;
    const state = createMockDoState({
      isActive: true,
      coinId: 'BTC/USDT',
      monitoredSymbols: ['BTC/USDT'],
      userId: 'user_alpha_1',
      strategy: 'scalper-v2',
      positionSize: 100,
      'lock:alarmGeneration': 2,
      candidateApprovalGeneration: 7,
      approvedCandidateRecord: {
        approvalGeneration: 7,
        userId: 'user_alpha_1',
        budgetUsdt: 100,
        approvedSymbols: ['BTC/USDT', 'BTCUSDT', 'ETH/USDT', 'ETHUSDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'testnet',
        accountFingerprint: 'bybit:testnet',
        orderType: 'ALL',
        approvedAt: Date.now() - 1000,
        expiresAt: approvalExpiresAt,
        symbolMetadataSnapshot: {
          'BTC/USDT': {
            priceAtApproval: 50000,
            qtyStep: 0.001,
            minOrderQty: 0.001,
            minNotional: 5,
            maxOrderQty: 1000,
          },
          'ETH/USDT': {
            priceAtApproval: 3000,
            qtyStep: 0.01,
            minOrderQty: 0.01,
            minNotional: 5,
            maxOrderQty: 1000,
          },
        },
      },
    });

    const bot = new TradingBot(state, env);

    // Read-only monitor state check
    const postMonitorRes = await bot.fetch(new Request('https://do/internal/monitor-state', { method: 'POST' }));
    expect(postMonitorRes.status).toBe(405);
    const getMonitorRes = await bot.fetch(new Request('https://do/internal/monitor-state', { method: 'GET' }));
    expect(getMonitorRes.status).toBe(200);
    const monitorJson = (await getMonitorRes.json()) as any;
    expect(monitorJson.ok).toBe(true);
    expect(monitorJson.readOnly).toBe(true);
    expect(monitorJson.candidateApprovalGeneration).toBe(7);

    // Run autonomous alarm loop (Journey B Stages 1..6)
    await bot.alarm();
    await state.drainWaits();

    // Execute filled trade via /execute-trade (Stages 6 & 7: TradeValidator, FinalDispatchSafetyGate, Fence B, WAL, Ack != Fill)
    const currentGen = Number(state.storageMap.get('lock:alarmGeneration') || 2);
    const existingAlerts = (state.storageMap.get('alerts') as any[]) || [];
    state.storageMap.set('alerts', [
      ...existingAlerts,
      {
        id: 'alert_exec_1',
        symbol: 'BTC/USDT',
        side: 'BUY',
        price: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        quantity: 0.002,
        positionSize: 100,
        isExecutable: true,
        strategy: 'ScalperV2',
        timeframe: '15m',
        status: 'pending',
        source: 'AUTONOMOUS',
        generation: currentGen,
        approvalGeneration: 7,
        timestamp: new Date().toISOString(),
      },
      {
        id: 'alert_exec_ack_only',
        symbol: 'ETH/USDT',
        side: 'BUY',
        price: 3000,
        entryPrice: 3000,
        stopLoss: 2940,
        takeProfit: 3120,
        quantity: 0.03,
        positionSize: 100,
        isExecutable: true,
        strategy: 'ScalperV2',
        timeframe: '15m',
        status: 'pending',
        source: 'AUTONOMOUS',
        generation: currentGen,
        approvalGeneration: 7,
        timestamp: new Date().toISOString(),
      },
    ]);

    const execFilledRes = await bot.fetch(
      new Request('https://do/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert_exec_1', symbol: 'BTC/USDT', side: 'BUY' }),
      })
    );
    expect(execFilledRes.status).toBe(200);
    await state.drainWaits();

    // Test ack-only ('open', filled: 0) emits BYBIT_HTTP_ACK without EXCHANGE_FILL_CONFIRMED
    const mockProvider = await ExchangeManager.getProvider({} as any);
    (mockProvider.createOrder as any).mockResolvedValueOnce({
      id: 'bybit_ord_ack_only',
      clientOrderId: 'cli_ord_ack_only',
      symbol: 'ETH/USDT',
      type: 'market',
      side: 'buy',
      amount: 0.03,
      filled: 0,
      remaining: 0.03,
      price: 3000,
      average: undefined,
      status: 'open',
      stopLoss: 2940,
      takeProfit: 3120,
    });
    const execAckOnlyRes = await bot.fetch(
      new Request('https://do/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert_exec_ack_only', symbol: 'ETH/USDT', side: 'BUY' }),
      })
    );
    expect(execAckOnlyRes.status).toBe(200);
    await state.drainWaits();

    // Verify Stage 8 sendTradeNotification & sendTradeFillNotification
    const emitters = createScopedTelemetryEmitter('crypto-pulse-backend', env);
    await runWithTelemetryContext(
      {
        journey: 'JOURNEY_B_AUTONOMOUS',
        cycleId: 'CYC-STAGE8',
        traceId: 'trc_stage8',
        userId: 'user_alpha_1',
        emitter: emitters,
      },
      async () => {
        const alertRes = await sendTradeNotification(env, 'user_alpha_1', 'alert_test_8', {
          symbol: 'BTC/USDT',
          side: 'BUY',
          entryPrice: 50000,
          stopLoss: 49000,
          takeProfit: 52000,
          estimatedPnl: 12.5,
          quantity: 0.002,
          isExecutable: true,
          strategy: 'scalper-v2',
          timeframe: '15m',
        }, undefined, 300);
        expect(alertRes.success).toBe(true);
        expect(alertRes.messageId).toBe('projects/cryptopulse-test/messages/msg_stage8_001');

        await sendTradeFillNotification(env, 'user_alpha_1', {
          alertId: 'alert_test_8',
          orderId: 'bybit_ord_1001',
          symbol: 'BTC/USDT',
          side: 'BUY',
          entryPrice: 50000,
          stopLoss: 49000,
          takeProfit: 52000,
          strategy: 'scalper-v2',
          actionType: 'TRADE_FILLED',
        });

        // ReconciliationEngine Stage 7 span
        await ReconciliationEngine.reconcile(
          {
            fetchOrder: vi.fn().mockResolvedValue({
              id: 'bybit_ord_1001',
              status: 'closed',
              filled: 0.002,
              amount: 0.002,
              average: 50000,
              stopLoss: 49000,
              takeProfit: 52000,
            }),
            fetchPositions: vi.fn().mockResolvedValue([
              { symbol: 'BTC/USDT', side: 'long', contracts: 0.002, stopLoss: 49000, takeProfit: 52000 },
            ]),
            setTradingStop: vi.fn(),
          } as any,
          {
            intentId: 'int_recon_1',
            symbol: 'BTC/USDT',
            side: 'BUY',
            status: 'DISPATCHED',
            actualOrderId: 'bybit_ord_1001',
            dispatchedAt: Date.now() - 5000,
          } as any,
          Date.now(),
          0.1
        );
      }
    );
    await emitters.flush();

    // Stage 9 Android ingestion gateway (enforce JWT sub over forged body userId)
    const app = new Hono<any>();
    app.post('/api/client/telemetry', async (c, next) => {
      c.set('jwtPayload', { sub: 'verified_jwt_user_9' });
      await next();
    }, handleReportClientIncident);

    const stage9Req = new Request('https://api.test/api/client/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            spanId: 'spn_android_1',
            stage: 9,
            userId: 'forged_attacker_id',
            alertId: 'alert_test_8',
            fcmMessageId: 'projects/cryptopulse-test/messages/msg_stage8_001',
            symbol: 'BTC/USDT',
            strategyId: 'scalper-v2',
            timeframe: '15m',
            component: 'FcmService',
            eventType: 'ANDROID_FCM_RECEIVED',
            status: 'PASS',
            message: 'FCM message received on Android',
            outputSummary: {
              eligibilityOutcome: 'ELIGIBLE_OS_UNPROVABLE',
              postNotifyVerified: true,
              renderedFields: { symbol: 'BTC/USDT', strategyId: 'scalper-v2', timeframe: '15m', price: 50000 },
            },
          },
        ],
      }),
    });
    const stage9Res = await app.fetch(stage9Req, env);
    expect(stage9Res.status).toBe(202);
    const stage9Json = (await stage9Res.json()) as any;
    expect(stage9Json.accepted).toBe(1);
    expect(stage9Json.ids).toEqual(['spn_android_1']);

    // Validate oversized / too many events rejection
    const tooManyRes = await app.fetch(
      new Request('https://api.test/api/client/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: new Array(26).fill({ stage: 9, eventType: 'X' }) }),
      }),
      env
    );
    expect(tooManyRes.status).toBe(400);

    const allEvents: PipelineTelemetryEvent[] = envelopes.flatMap((e) => e.events);
    expect(allEvents.some((e) => e.journey === 'JOURNEY_B_AUTONOMOUS' && e.eventType === 'AUTONOMOUS_CYCLE_START')).toBe(true);
    expect(allEvents.some((e) => e.stage === 2 && e.eventType === 'DISCOVERY_HANDOFF_CONSUMED' && e.parentApprovalGeneration === 7)).toBe(true);
    expect(allEvents.some((e) => e.stage === 3 && e.eventType === 'CANDLE_DATASET_READY')).toBe(true);
    expect(allEvents.some((e) => e.stage === 4 && e.eventType === 'TA_COMPUTED' && e.outputSummary?.indicatorEngine === 'CANONICAL')).toBe(true);
    expect(allEvents.some((e) => e.stage === 6 && e.eventType === 'PRE_TA_ELIGIBILITY_GATE')).toBe(true);
    expect(allEvents.some((e) => e.stage === 6 && e.eventType === 'SIGNAL_SHADOW_DIFF')).toBe(true);
    expect(allEvents.some((e) => e.stage === 6 && e.eventType === 'TRADE_VALIDATOR_CHECK')).toBe(true);
    expect(allEvents.some((e) => e.stage === 6 && e.eventType === 'FINAL_DISPATCH_SAFETY_GATE')).toBe(true);
    expect(allEvents.some((e) => e.stage === 6 && e.eventType === 'FENCE_B_DISPATCH_LEASE')).toBe(true);
    expect(allEvents.some((e) => e.stage === 7 && e.eventType === 'ORDER_INTENT_RESERVED')).toBe(true);
    expect(allEvents.some((e) => e.stage === 7 && e.eventType === 'ORDER_SUBMIT_DISPATCHED')).toBe(true);
    expect(allEvents.some((e) => e.stage === 7 && e.eventType === 'BYBIT_HTTP_ACK' && e.alertId === 'alert_exec_1')).toBe(true);
    expect(allEvents.some((e) => e.stage === 7 && e.eventType === 'EXCHANGE_FILL_CONFIRMED' && e.alertId === 'alert_exec_1')).toBe(true);
    expect(allEvents.some((e) => e.stage === 7 && e.eventType === 'POSITION_D1_SYNCED' && e.alertId === 'alert_exec_1')).toBe(true);

    // Ack-only order must emit BYBIT_HTTP_ACK with isAckOnly: true and NO EXCHANGE_FILL_CONFIRMED
    const ackOnlySpan = allEvents.find((e) => e.stage === 7 && e.eventType === 'BYBIT_HTTP_ACK' && e.alertId === 'alert_exec_ack_only');
    expect(ackOnlySpan).toBeDefined();
    expect(ackOnlySpan?.outputSummary?.isAckOnly).toBe(true);
    expect(allEvents.some((e) => e.stage === 7 && e.eventType === 'EXCHANGE_FILL_CONFIRMED' && e.alertId === 'alert_exec_ack_only')).toBe(false);

    const fcmAlertSpan = allEvents.find((e) => e.stage === 8 && e.eventType === 'FCM_ALERT_DISPATCHED');
    const fcmFillSpan = allEvents.find((e) => e.stage === 8 && e.eventType === 'FCM_FILL_DISPATCHED');
    expect(fcmAlertSpan?.fcmMessageId).toBe('projects/cryptopulse-test/messages/msg_stage8_001');
    expect(fcmFillSpan?.outputSummary?.hasPlaceholderPnl3).toBe(true);
    expect(fcmFillSpan?.outputSummary?.hasTimeframe).toBe(false);

    const stage9Event = allEvents.find((e) => e.stage === 9 && e.spanId === 'spn_android_1');
    expect(stage9Event?.userId).toBe('verified_jwt_user_9');

    // Secret-leak verification across ALL envelopes
    const serializedAll = JSON.stringify(envelopes);
    for (const forbidden of ['test_api_key_redacted', 'enc_secret_redacted', 'mocked_decrypted_secret_never_logged', 'mock_oauth_token_never_logged', fcmTokenOrPrivateCheck()]) {
      expect(serializedAll).not.toContain(forbidden);
    }
    for (const key of FORBIDDEN_TELEMETRY_KEYS) {
      expect(allEvents.every((ev) => !(key in (ev.inputSummary || {})) && !(key in (ev.outputSummary || {})))).toBe(true);
    }
  });

  it('remains strictly fail-open when TELEMETRY_QUEUE.send throws', async () => {
    const failingEnv: any = {
      ENVIRONMENT: 'testnet',
      FCM_SERVER_KEY: 'legacy_test_key',
      DB: createMockD1(),
      TELEMETRY_QUEUE: {
        send: vi.fn().mockRejectedValue(new Error('QUEUE_OUTAGE')),
      },
    };
    const emitter = createScopedTelemetryEmitter('crypto-pulse-backend', failingEnv);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: 1 }), { status: 200 })) as any;

    const dispatch = await runWithTelemetryContext(
      { journey: 'JOURNEY_B_AUTONOMOUS', cycleId: 'cyc_failopen', emitter },
      async () =>
        sendTradeNotification(failingEnv, 'user_failopen', 'alert_failopen', {
          symbol: 'BTC/USDT',
          side: 'BUY',
          entryPrice: 50000,
          stopLoss: 49000,
          takeProfit: 52000,
          quantity: 0.002,
          isExecutable: true,
          strategy: 'scalper-v2',
        })
    );
    await expect(emitter.flush()).resolves.toBeDefined();
    expect(dispatch.success).toBe(true);
  });
});

function fcmTokenOrPrivateCheck() {
  return 'fcm_device_token_secret_abc';
}
