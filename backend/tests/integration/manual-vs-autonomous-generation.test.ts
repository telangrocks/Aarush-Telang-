import { describe, it, expect, vi, beforeEach } from 'vitest';
import BigNumber from 'bignumber.js';
import { TradingBot, TradeAlert } from '../../src/trading-bot';
import { BybitAdapter } from '../../src/infrastructure/exchange/adapters/BybitAdapter';
import { ExchangeOrchestrator } from '../../src/infrastructure/orchestrator/ExchangeOrchestrator';
import { handleExecuteTrade, handleTriggerManualTradeAlert, handleGetPersonalizedMarketCandidates, invalidateExchangeConnection } from '../../src/handlers/exchange';

vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('mocked_secret_key')
}));

vi.mock('../../src/exchanges', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: vi.fn().mockResolvedValue({ symbol: 'BTCUSDT', last: 50100, bid: 50090, ask: 50110 }),
        fetchKlines: vi.fn().mockImplementation(() =>
          Promise.resolve(
            Array.from({ length: 30 }, (_, i) => ({
              openTime: Date.now() - (30 - i) * 3600000,
              open: 50000 + i,
              high: 50100 + i,
              low: 49900 + i,
              close: 50050 + i,
              volume: 500,
            }))
          )
        ),
        fetchBalance: vi.fn().mockResolvedValue({
          free: { USDT: 5000 },
          total: { USDT: 5000 },
        }),
        fetchMarkets: vi.fn().mockResolvedValue([
          {
            id: 'BTCUSDT',
            symbol: 'BTC/USDT',
            category: 'linear',
            precision: { price: 0.1, amount: 0.001 },
            limits: {
              cost: { min: 5 },
              amount: { min: 0.001 }
            }
          }
        ]),
        fetchMarket: vi.fn().mockImplementation(async (sym: string) => ({
          id: 'BTCUSDT',
          symbol: 'BTC/USDT',
          category: 'linear',
          precision: { price: 0.1, amount: 0.001 },
          limits: {
            cost: { min: 5 },
            amount: { min: 0.001 }
          }
        })),
        fetchPositions: vi.fn().mockResolvedValue([]),
        createOrder: vi.fn().mockResolvedValue({ id: 'ord-123', status: 'closed', filled: { toNumber: () => 0.02 }, amount: { toNumber: () => 0.02 }, average: { toNumber: () => 50100 } }),
        supportsOco: vi.fn().mockReturnValue(false),
        createOcoOrder: vi.fn()
      }),
      executeIdempotentOrder: vi.fn().mockResolvedValue({ id: 'ord-123', status: 'closed', filled: { toNumber: () => 0.02 }, amount: { toNumber: () => 0.02 }, average: { toNumber: () => 50100 } }),
      executeIdempotentOcoOrder: vi.fn()
    },
    normalizeEnvironment: vi.fn().mockReturnValue('testnet'),
    normalizeRegion: vi.fn().mockReturnValue('global'),
  };
});

describe('Manual vs Autonomous Alert Generation Lineage', () => {
  let mockState: any;
  let mockStorage: Map<string, any>;
  let mockEnv: any;
  let mockDb: any;

  beforeEach(() => {
    mockStorage = new Map<string, any>();

    mockState = {
      storage: {
        get: vi.fn(async (key: string | string[]) => {
          if (Array.isArray(key)) {
            const map = new Map();
            key.forEach((k) => {
              if (mockStorage.has(k)) map.set(k, mockStorage.get(k));
            });
            return map;
          }
          return mockStorage.get(key);
        }),
        put: vi.fn(async (key: string | Record<string, any>, value?: any) => {
          if (typeof key === 'string') {
            mockStorage.set(key, value);
          } else {
            Object.entries(key).forEach(([k, v]) => mockStorage.set(k, v));
          }
        }),
        delete: vi.fn(async (key: string | string[]) => {
          if (Array.isArray(key)) {
            key.forEach((k) => mockStorage.delete(k));
          } else {
            mockStorage.delete(key);
          }
        }),
        transaction: vi.fn(async (closure: any) => {
          return await closure({
            get: async (k: string) => mockStorage.get(k),
            put: async (k: string, v: any) => mockStorage.set(k, v),
            delete: async (k: string) => mockStorage.delete(k),
          });
        }),
        setAlarm: vi.fn().mockResolvedValue(undefined),
        deleteAlarm: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockImplementation(async (options?: any) => {
          const map = new Map();
          const prefix = options?.prefix;
          for (const [k, v] of mockStorage.entries()) {
            if (!prefix || k.startsWith(prefix)) {
              map.set(k, v);
            }
          }
          return map;
        }),
      },
      blockConcurrencyWhile: vi.fn(async (fn: any) => await fn()),
    };

    mockDb = {
      prepare: vi.fn().mockImplementation((query: string) => {
        if (query.includes('PRAGMA table_info')) {
          return {
            all: vi.fn().mockResolvedValue({
              results: [{ name: 'target_entry_price' }, { name: 'entry_status' }],
            }),
          };
        }
        return {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ success: true }),
            first: vi.fn().mockResolvedValue({
              exchange_name: 'bybit',
              exchange_environment: 'demo',
              exchange_region: 'global',
              exchange_api_key: 'test-key',
              exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
              exchange_api_secret_encrypted: 'sec',
            }),
          }),
        };
      }),
    };

    mockEnv = {
      DB: mockDb,
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
  });

  it('Autonomous alert: succeeds when generation matches currentGen', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 5);

    const autoAlert: TradeAlert = {
      id: 'auto-alert-1',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      generation: 5,
      source: 'AUTONOMOUS',
    };
    mockStorage.set('alerts', [autoAlert]);

    const res = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'auto-alert-1' }),
      })
    );

    expect(res.status).toBe(200);
  });

  it('Autonomous alert: strictly rejected with HTTP 409 when generation is obsolete', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 6); // Generation rolled over to 6

    const staleAutoAlert: TradeAlert = {
      id: 'auto-alert-stale',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      generation: 5, // Old generation 5
      source: 'AUTONOMOUS',
    };
    mockStorage.set('alerts', [staleAutoAlert]);

    const res = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'auto-alert-stale' }),
      })
    );

    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.error).toContain('obsolete or invalid alarm generation');
  });

  it('Autonomous alert: strictly rejected with HTTP 409 when generation is missing', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 5);

    const legacyAlert: TradeAlert = {
      id: 'auto-alert-no-gen',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      // No generation and not marked MANUAL (defaults to autonomous)
    };
    mockStorage.set('alerts', [legacyAlert]);

    const res = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'auto-alert-no-gen' }),
      })
    );

    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.error).toContain('obsolete or invalid alarm generation');
  });

  it('Manual alert: executes successfully when registered via /register-alert with no generation', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('lock:alarmGeneration', 10); // Generation counter is at 10

    const manualAlert = {
      id: 'manual-alert-ta-screen',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      // NO generation!
    };

    // 1. Register alert via /register-alert (as exchange.ts does)
    const regRes = await bot.fetch(
      new Request('http://bot/register-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert: manualAlert }),
      })
    );
    expect(regRes.status).toBe(200);

    // 2. User confirms and presses EXECUTE TRADE -> /execute-trade
    const execRes = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'manual-alert-ta-screen' }),
      })
    );

    expect(execRes.status).toBe(200);
    const execBody = await execRes.json<any>();
    expect(execBody.success).toBe(true);
  });

  it('Manual alert: does NOT fail even if autonomous alarmGeneration rolls over', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('lock:alarmGeneration', 1);

    const manualAlert = {
      id: 'manual-alert-independent',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      source: 'MANUAL',
    };

    // Alert registered at generation 1
    mockStorage.set('alerts', [manualAlert]);

    // Background autonomous alarm activates / deactivates / switches strategy, advancing generation to 4
    mockStorage.set('lock:alarmGeneration', 4);

    // Manual trade executed now
    const execRes = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'manual-alert-independent' }),
      })
    );

    // Must NOT fail with "Alert belongs to an obsolete or invalid alarm generation"
    expect(execRes.status).toBe(200);
  });

  it('Manual alert: expired signals (>5 min) are still safely rejected with 400', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');

    const expiredManualAlert = {
      id: 'manual-expired',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date(Date.now() - 360000).toISOString(), // 6 minutes ago (>5 min TTL)
      status: 'pending',
      source: 'MANUAL',
    };
    mockStorage.set('alerts', [expiredManualAlert]);

    const execRes = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'manual-expired' }),
      })
    );

    expect(execRes.status).toBe(400);
    const body = await execRes.json<any>();
    expect(body.error).toContain('Signal has expired');
  });

  it('Autonomous alert producer (actual path): tags generated alert with cycle generation and source AUTONOMOUS, which then passes execution gate', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('monitoredSymbols', ['BTC/USDT']);
    mockStorage.set('lock:alarmGeneration', 7);
    mockStorage.set('positionSize', 100);

    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      {
        strategyId: 'ScalperV2',
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            targetEntryPrice: 50000,
            stopLoss: 49000,
            takeProfit: 52000,
            timeframe: '5m',
            riskAssessment: {
              positionSizeRecommendation: 100,
            },
          },
          reasoning: ['Confirmed buy signal for ScalperV2'],
        },
      },
    ]);

    // 1. Run the actual autonomous alarm cycle
    await bot.alarm();

    // 2. Verify alert was generated with validated cycle generation and source
    const alerts = mockStorage.get('alerts') as TradeAlert[] || [];
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const producedAlert = alerts[0];
    expect(producedAlert.symbol).toBe('BTC/USDT');
    expect(producedAlert.generation).toBe(7);
    expect(producedAlert.source).toBe('AUTONOMOUS');
    expect(producedAlert.status).toBe('pending');

    // 3. Verify the generated alert passes the execution gate with HTTP 200
    const execRes = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: producedAlert.id }),
      })
    );

    expect(execRes.status).toBe(200);
    const execBody = await execRes.json<any>();
    expect(execBody.success).toBe(true);
  });

  it('Autonomous alert producer (actual path): fails closed (skips alert creation) when lock:alarmGeneration is missing', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('monitoredSymbols', ['BTC/USDT']);
    // lock:alarmGeneration is NOT set (undefined)
    mockStorage.set('positionSize', 100);

    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      {
        strategyId: 'ScalperV2',
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            targetEntryPrice: 50000,
            stopLoss: 49000,
            takeProfit: 52000,
            timeframe: '5m',
            riskAssessment: {
              positionSizeRecommendation: 100,
            },
          },
          reasoning: ['Confirmed buy signal for ScalperV2'],
        },
      },
    ]);

    // Run alarm cycle without a valid generation
    await bot.alarm();

    // Must NOT publish any alert with missing/unvalidated generation
    const alerts = mockStorage.get('alerts') as TradeAlert[] || [];
    expect(alerts).toHaveLength(0);
  });

  it('Autonomous alert producer (actual path): fails closed when lock:alarmGeneration is malformed/invalid', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('monitoredSymbols', ['BTC/USDT']);
    mockStorage.set('lock:alarmGeneration', -5); // Invalid generation
    mockStorage.set('positionSize', 100);

    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      {
        strategyId: 'ScalperV2',
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            targetEntryPrice: 50000,
            stopLoss: 49000,
            takeProfit: 52000,
            timeframe: '5m',
            riskAssessment: {
              positionSizeRecommendation: 100,
            },
          },
          reasoning: ['Confirmed buy signal for ScalperV2'],
        },
      },
    ]);

    await bot.alarm();

    const alerts = mockStorage.get('alerts') as TradeAlert[] || [];
    expect(alerts).toHaveLength(0);
  });

  it('Autonomous alert producer (storage fault-injection): discards alert if generation mutates in storage mid-cycle before publication', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('monitoredSymbols', ['BTC/USDT']);
    mockStorage.set('lock:alarmGeneration', 7);
    mockStorage.set('positionSize', 100);

    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockImplementation(async () => {
      // Storage fault-injection: simulate generation mutation in storage mid-cycle
      mockStorage.set('lock:alarmGeneration', 8);
      return [
        {
          strategyId: 'ScalperV2',
          confidenceScore: 90,
          hasSignal: true,
          metadata: {
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              targetEntryPrice: 50000,
              stopLoss: 49000,
              takeProfit: 52000,
              timeframe: '5m',
              riskAssessment: {
                positionSizeRecommendation: 100,
              },
            },
            reasoning: ['Confirmed buy signal for ScalperV2'],
          },
        },
      ];
    });

    await bot.alarm();

    const alerts = mockStorage.get('alerts') as TradeAlert[] || [];
    expect(alerts).toHaveLength(0);
  });

  it('Autonomous alert producer (storage fault-injection): discards alert if isActive becomes false in storage mid-cycle before publication', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('monitoredSymbols', ['BTC/USDT']);
    mockStorage.set('lock:alarmGeneration', 7);
    mockStorage.set('positionSize', 100);

    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockImplementation(async () => {
      // Storage fault-injection: simulate deactivation in storage mid-cycle
      mockStorage.set('isActive', false);
      return [
        {
          strategyId: 'ScalperV2',
          confidenceScore: 90,
          hasSignal: true,
          metadata: {
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              targetEntryPrice: 50000,
              stopLoss: 49000,
              takeProfit: 52000,
              timeframe: '5m',
              riskAssessment: {
                positionSizeRecommendation: 100,
              },
            },
            reasoning: ['Confirmed buy signal for ScalperV2'],
          },
        },
      ];
    });

    await bot.alarm();

    const alerts = mockStorage.get('alerts') as TradeAlert[] || [];
    expect(alerts).toHaveLength(0);
  });

  // ============================================================================
  // Regression Tests T1–T21: Consolidated Autonomous Execution & Safety Suite
  // ============================================================================

  it('T1: Concurrent /activate and /deactivate serialize via lifecycleMutex and advance lock:alarmGeneration monotonically', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('lock:alarmGeneration', 10);

    const autoPending: TradeAlert = {
      id: 'auto-pend-t1',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      source: 'AUTONOMOUS',
      generation: 10,
    };
    const manualPending: TradeAlert = {
      ...autoPending,
      id: 'man-pend-t1',
      source: 'MANUAL',
      generation: undefined,
    };
    mockStorage.set('alerts', [autoPending, manualPending]);

    const actPromise = bot.fetch(
      new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-test-1',
          strategy: 'ScalperV2',
          positionSize: 100,
          coinId: 'BTC/USDT',
          monitoredSymbols: ['BTC/USDT'],
        }),
      })
    );
    const deactPromise = bot.fetch(
      new Request('http://bot/deactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const [actRes, deactRes] = await Promise.all([actPromise, deactPromise]);
    expect(actRes.status).toBe(200);
    expect(deactRes.status).toBe(200);

    // Generation incremented once by /activate (11) and once by /deactivate (12)
    expect(mockStorage.get('lock:alarmGeneration')).toBe(12);
    expect(mockStorage.get('isActive')).toBe(false);

    // Autonomous pending alert was expired, while manual pending alert was preserved
    const storedAlerts = mockStorage.get('alerts') as TradeAlert[];
    const autoAfter = storedAlerts.find((a) => a.id === 'auto-pend-t1');
    const manAfter = storedAlerts.find((a) => a.id === 'man-pend-t1');
    expect(autoAfter?.status).toBe('expired');
    expect(manAfter?.status).toBe('pending');
  });

  it('T2 & T3: Autonomous alert succeeds when active+matching generation, and fails with 409 when bot is inactive', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', false); // Bot is inactive
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 5);

    const autoAlert: TradeAlert = {
      id: 'auto-inactive-t3',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      generation: 5,
      source: 'AUTONOMOUS',
    };
    mockStorage.set('alerts', [autoAlert]);

    const res = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'auto-inactive-t3' }),
      })
    );
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.code).toBe('BOT_INACTIVE_AUTONOMOUS_REJECTED');
  });

  it('T4 & T5: Alert with invalid provenance or manual alert carrying generation is rejected with 409; handler stamps MANUAL provenance', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 5);

    const corruptedManual: any = {
      id: 'corrupt-man-t4',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      source: 'MANUAL',
      generation: 5, // Illegal: MANUAL alert cannot carry autonomous generation
    };
    mockStorage.set('alerts', [corruptedManual]);

    const res = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'corrupt-man-t4' }),
      })
    );
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.code).toBe('INVALID_ALERT_PROVENANCE');

    // Verify handleExecuteTrade maps HTTP 200 { success: false } to 409 properly
    let recordedStatus = 200;
    const mockHonoCtx: any = {
      get: vi.fn().mockReturnValue({ sub: 'user-test-1' }),
      req: {
        json: vi.fn().mockResolvedValue({ alertId: 'a1' }),
      },
      env: {
        TRADING_BOTS: {
          idFromName: vi.fn().mockReturnValue('id-1'),
          get: vi.fn().mockReturnValue({
            fetch: vi.fn().mockResolvedValue(
              new Response(JSON.stringify({ success: false, error: 'Blocked' }), { status: 200 })
            ),
          }),
        },
      },
      status: vi.fn((s: number) => {
        recordedStatus = s;
      }),
      json: vi.fn((payload: any) => new Response(JSON.stringify(payload), { status: recordedStatus })),
    };
    const handlerRes = await handleExecuteTrade(mockHonoCtx);
    expect(recordedStatus).toBe(409);
    expect(handlerRes.status).toBe(409);
  });

  it('T6: Fence B race — /deactivate during pre-dispatch async work aborts autonomous order before fetchWithTimeout and marks intent FAILED', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 3);

    const autoAlert: TradeAlert = {
      id: 'auto-race-t6',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      generation: 3,
      source: 'AUTONOMOUS',
    };
    mockStorage.set('alerts', [autoAlert]);

    const { ExchangeManager } = await import('../../src/exchanges');
    const createOrderSpy = vi.fn().mockResolvedValue({ id: 'should-not-be-called' });
    (ExchangeManager.getProvider as any).mockImplementationOnce(async () => ({
      fetchTicker: vi.fn().mockResolvedValue({ symbol: 'BTCUSDT', last: 50100, bid: 50090, ask: 50110 }),
      fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 5000 }, total: { USDT: 5000 } }),
      fetchMarket: vi.fn().mockImplementation(async () => {
        // Concurrent /deactivate happens AFTER Fence A passes, while pre-dispatch metadata fetch is running!
        await bot.fetch(new Request('http://bot/deactivate', { method: 'POST' }));
        return {
          id: 'BTCUSDT',
          symbol: 'BTC/USDT',
          category: 'linear',
          precision: { price: 0.1, amount: 0.001 },
          limits: { cost: { min: 5 }, amount: { min: 0.001 } },
        };
      }),
      fetchPositions: vi.fn().mockResolvedValue([]),
      createOrder: createOrderSpy,
      supportsOco: vi.fn().mockReturnValue(false),
    }));

    const res = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'auto-race-t6' }),
      })
    );

    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.code).toBe('BOT_INACTIVE_AUTONOMOUS_REJECTED');
    expect(body.message).toContain('Fence B');
    expect(createOrderSpy).not.toHaveBeenCalled();

    const savedIntent = mockStorage.get('intent:order:auto-race-t6');
    expect(savedIntent).toBeDefined();
    expect(savedIntent.status).toBe('FAILED');
    expect(savedIntent.dispatchedAt).toBeUndefined();
  });

  it('T7 & T8: Dispatch-lease holds lifecycleMutex until fetchWithTimeout is invoked, releases before awaiting network response, and guarantees release on synchronous error', async () => {
    const events: string[] = [];
    let resolveNetwork!: (val: any) => void;
    const networkPromise = new Promise((r) => {
      resolveNetwork = r;
    });

    const adapter = new BybitAdapter();
    await adapter.connect({
      apiKey: 'bybit-key',
      secret: 'bybit-secret',
      environment: 'testnet',
    } as any);

    vi.spyOn(adapter as any, 'getSyncedTimestamp').mockImplementation(async () => {
      events.push('timestamp_synced');
      return '1700000000000';
    });

    vi.spyOn(adapter as any, 'fetchWithTimeout').mockImplementation((url: string) => {
      if (url.includes('/v5/order/create')) {
        events.push('fetch_invoked');
        return networkPromise.then(() => {
          events.push('network_resolved');
          return new Response(
            JSON.stringify({
              retCode: 0,
              retMsg: 'OK',
              result: { orderId: 'bybit-ord-t7', orderLinkId: 'cid-t7' },
            }),
            { status: 200 }
          );
        });
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            retCode: 0,
            result: { list: [{ orderId: 'bybit-ord-t7', orderStatus: 'Filled', cumExecQty: '0.02', avgPrice: '50000', stopLoss: '49000', takeProfit: '52000' }] },
          }),
          { status: 200 }
        )
      );
    });

    let leaseHeld = false;
    const orderPromise = adapter.createOrder({
      symbol: 'BTC/USDT',
      type: 'market',
      side: 'buy',
      amount: new BigNumber(0.02),
      clientOrderId: 'cid-t7',
      category: 'linear',
      pollDelayMs: 1,
      beforeOrderDispatch: async () => {
        events.push('lease_acquired');
        leaseHeld = true;
        return () => {
          events.push('lease_released');
          leaseHeld = false;
        };
      },
    } as any);

    // Wait a microtask tick so getSyncedTimestamp, HMAC signing, beforeOrderDispatch, and fetchWithTimeout run
    await new Promise((r) => setTimeout(r, 20));

    // At this point, fetchWithTimeout has been invoked, lease has ALREADY been released, and networkPromise is STILL pending!
    expect(events).toEqual(['timestamp_synced', 'lease_acquired', 'fetch_invoked', 'lease_released']);
    expect(leaseHeld).toBe(false);

    resolveNetwork(undefined);
    const created = await orderPromise;
    expect(created.id).toBe('bybit-ord-t7');
    expect(events).toContain('network_resolved');
    expect(events.indexOf('lease_released')).toBeLessThan(events.indexOf('network_resolved'));

    // T8: Synchronous throw inside fetchWithTimeout still releases lease in finally
    let leaseReleasedOnError = false;
    vi.spyOn(adapter as any, 'fetchWithTimeout').mockImplementationOnce(() => {
      throw new Error('Sync socket setup failure');
    });

    await expect(
      adapter.createOrder({
        symbol: 'BTC/USDT',
        type: 'market',
        side: 'buy',
        amount: new BigNumber(0.02),
        clientOrderId: 'cid-t8',
        category: 'linear',
        beforeOrderDispatch: async () => {
          return () => {
            leaseReleasedOnError = true;
          };
        },
      } as any)
    ).rejects.toThrow('Sync socket setup failure');
    expect(leaseReleasedOnError).toBe(true);
  });

  it('T9 & T10: WAL evidence is permanently retained (deleteIntent is no-op), blocks replay with HTTP 409 across restarts, and enforces monotonic status/fill transitions', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 5);

    const alertT9: TradeAlert = {
      id: 'alert-wal-t9',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      generation: 5,
      source: 'AUTONOMOUS',
    };
    mockStorage.set('alerts', [alertT9]);

    const firstRes = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert-wal-t9' }),
      })
    );
    expect(firstRes.status).toBe(200);

    // WAL record must remain in storage even after completion
    const storedWal = mockStorage.get('intent:order:alert-wal-t9');
    expect(storedWal).toBeDefined();
    expect(storedWal.status).toBe('FILLED');
    expect(storedWal.dispatchedAt).toBeTypeOf('number');

    // Simulate DO restart with a fresh TradingBot instance and attempt replay even if alert status were mutated back to pending
    mockStorage.set('alerts', [{ ...alertT9, status: 'pending' }]);
    const restartedBot = new TradingBot(mockState, mockEnv);
    const replayRes = await restartedBot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert-wal-t9' }),
      })
    );
    expect(replayRes.status).toBe(409);
    const replayBody = await replayRes.json<any>();
    expect(replayBody.code).toBe('DUPLICATE_DISPATCH_BLOCKED');

    // T10: Monotonic snapshot regression attempt (trying to overwrite FILLED w/ qty 0.02 back to DISPATCHED w/ qty 0.005)
    const afterRegressionAttempt = await restartedBot.persistIntentSnapshot('alert-wal-t9', {
      intentId: 'alert-wal-t9',
      status: 'DISPATCHED',
      actualExecutedQuantity: 0.005,
    });
    expect(afterRegressionAttempt.status).toBe('FILLED');
    expect(Number(afterRegressionAttempt.actualExecutedQuantity)).toBe(0.02);
  });

  it('T11 & T12: Crash recovery — pre-dispatch INTENT_PERSISTED aborts to FAILED without exchange call; post-dispatch DISPATCHED reconciles without duplicate order', async () => {
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', false); // Runs even when deactivated

    // Pre-dispatch crashed intent (no dispatchedAt)
    mockStorage.set('intent:order:crashed-pre-t11', {
      intentId: 'crashed-pre-t11',
      symbol: 'BTC/USDT',
      side: 'buy',
      status: 'INTENT_PERSISTED',
      dispatchedAt: undefined,
      createdAt: Date.now() - 10000,
    });

    // Post-dispatch crashed intent (has dispatchedAt)
    mockStorage.set('intent:order:crashed-post-t12', {
      intentId: 'crashed-post-t12',
      symbol: 'BTC/USDT',
      side: 'buy',
      qty: '0.02',
      price: '50000',
      status: 'DISPATCHED',
      dispatchedAt: Date.now() - 10000,
      createdAt: Date.now() - 10000,
      reconciliationAttemptCount: 0,
      payloadSnapshot: {
        symbol: 'BTC/USDT',
        side: 'buy',
        qty: '0.02',
        price: '50000',
        category: 'linear',
      },
    });

    const { ExchangeManager } = await import('../../src/exchanges');
    const createOrderSpy = vi.fn();
    (ExchangeManager.getProvider as any).mockResolvedValueOnce({
      fetchOrder: vi.fn().mockResolvedValue(null),
      fetchOpenOrders: vi.fn().mockResolvedValue([]),
      fetchClosedOrders: vi.fn().mockResolvedValue([
        {
          id: 'exch-ord-t12',
          clientOrderId: 'crashed-post-t12',
          status: 'closed',
          filled: new BigNumber(0.02),
          amount: new BigNumber(0.02),
          average: new BigNumber(50050),
          price: new BigNumber(50050),
        },
      ]),
      fetchPositions: vi.fn().mockResolvedValue([]),
      createOrder: createOrderSpy,
    });

    const bot = new TradingBot(mockState, mockEnv);
    await bot.alarm();

    expect(createOrderSpy).not.toHaveBeenCalled();

    const preIntent = mockStorage.get('intent:order:crashed-pre-t11');
    expect(preIntent.status).toBe('FAILED');
    expect(preIntent.terminalReason).toBe('PRE_DISPATCH_CRASH_ABORT');

    const postIntent = mockStorage.get('intent:order:crashed-post-t12');
    expect(postIntent.status).toBe('FILLED');
    expect(postIntent.actualOrderId).toBe('exch-ord-t12');
  });

  it('T13: Partial-fill accounting records actual filled_quantity and PARTIALLY_FILLED entry_status in D1 and WAL', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 5);

    const partialAlert: TradeAlert = {
      id: 'alert-partial-t13',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      generation: 5,
      source: 'AUTONOMOUS',
    };
    mockStorage.set('alerts', [partialAlert]);

    const { ExchangeManager } = await import('../../src/exchanges');
    (ExchangeManager.executeIdempotentOrder as any).mockResolvedValueOnce({
      id: 'ord-partial-t13',
      status: 'open',
      filled: { toNumber: () => 0.001 },
      amount: { toNumber: () => 0.002 },
      average: { toNumber: () => 50010 },
      stopLoss: 49000,
      takeProfit: 52000,
    });

    const d1UpdateBindings: any[][] = [];
    mockDb.prepare = vi.fn().mockImplementation((query: string) => {
      if (query.includes('PRAGMA table_info')) {
        return {
          all: vi.fn().mockResolvedValue({
            results: [{ name: 'target_entry_price' }, { name: 'entry_status' }],
          }),
        };
      }
      return {
        bind: vi.fn((...args: any[]) => {
          if (query.includes('UPDATE trade_positions')) {
            d1UpdateBindings.push(args);
          }
          return {
            run: vi.fn().mockResolvedValue({ success: true }),
            first: vi.fn().mockResolvedValue({
              exchange_name: 'bybit',
              exchange_environment: 'demo',
              exchange_region: 'global',
              exchange_api_key: 'test-key',
              exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
              exchange_api_secret_encrypted: 'sec',
            }),
          };
        }),
      };
    });

    const res = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert-partial-t13' }),
      })
    );
    expect(res.status).toBe(200);

    const wal = mockStorage.get('intent:order:alert-partial-t13');
    expect(wal.status).toBe('PARTIALLY_FILLED');
    expect(Number(wal.actualExecutedQuantity)).toBe(0.001);

    expect(d1UpdateBindings.length).toBeGreaterThanOrEqual(1);
    const posUpdateArgs = d1UpdateBindings[0];
    // UPDATE trade_positions SET status = ?, entry_status = ?, average_fill_price = ?, filled_quantity = ?
    expect(posUpdateArgs[0]).toBe('OPEN');
    expect(posUpdateArgs[1]).toBe('PARTIALLY_FILLED');
    expect(posUpdateArgs[2]).toBe(50010);
    expect(posUpdateArgs[3]).toBe(0.001);
  });

  it('T14: One-shot order mutation — ExchangeOrchestrator and BybitAdapter never auto-retry createOrder on network/5xx or 10002 errors', async () => {
    const adapter = new BybitAdapter();
    await adapter.connect({
      apiKey: 'bybit-key',
      secret: 'bybit-secret',
      environment: 'testnet',
    } as any);
    vi.spyOn(adapter as any, 'getSyncedTimestamp').mockResolvedValue('1700000000000');

    let fetchCalls = 0;
    vi.spyOn(adapter as any, 'fetchWithTimeout').mockImplementation(async () => {
      fetchCalls++;
      return new Response(
        JSON.stringify({
          retCode: 10002,
          retMsg: 'invalid request, please check your server timestamp or recv_window param',
        }),
        { status: 200 }
      );
    });

    const orchestrator = new ExchangeOrchestrator();
    const res = await orchestrator.execute(adapter as any, 'createOrder', (p: any) =>
      p.createOrder({
        symbol: 'BTC/USDT',
        type: 'market',
        side: 'buy',
        amount: new BigNumber(0.01),
        clientOrderId: 'cid-no-retry-t14',
        category: 'linear',
      })
    );
    expect(res.isFailure).toBe(true);

    // Must be called strictly ONCE (neither BybitAdapter 10002 retry nor ExchangeOrchestrator RetryPolicy retry)
    expect(fetchCalls).toBe(1);
  });

  it('T15, T16 & T17: Tick-size SL/TP verification, fail-safe reduce-only emergency close on missing/mismatched SL/TP, and HTTP 423 lock on subsequent trades', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 5);

    // T15: Direct verification with exact tick-quantized SL/TP succeeds
    const okProvider = {
      enforceProtectionCheck: true,
      fetchOrder: vi.fn().mockResolvedValue({
        id: 'ord-ok-t15',
        stopLoss: 49000,
        takeProfit: 52000,
      }),
      fetchPositions: vi.fn().mockResolvedValue([]),
    };
    const okVerify = await bot.verifyAndEnforceProtection({
      provider: okProvider,
      rawOrder: { id: 'ord-ok-t15', stopLoss: 49000, takeProfit: 52000 },
      positionId: 'pos-ok-t15',
      alertId: 'alert-ok-t15',
      userId: 'user-test-1',
      exchangeName: 'bybit',
      environment: 'testnet',
      symbol: 'BTC/USDT',
      category: 'linear',
      side: 'BUY',
      filledQuantity: 0.02,
      expectedSL: 49000,
      expectedTP: 52000,
      tickSize: 0.1,
    });
    expect(okVerify.verified).toBe(true);
    expect(okVerify.emergencyClosed).toBe(false);

    // T16: Entry fills, but SL/TP is missing on exchange AND emergency close encounters ambiguous network error -> HTTP 423 + lock:unprotectedExposure retained
    const alertT16: TradeAlert = {
      id: 'alert-unprot-t16',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      generation: 5,
      source: 'AUTONOMOUS',
    };
    const alertT17: TradeAlert = {
      ...alertT16,
      id: 'alert-blocked-t17',
      symbol: 'ETH/USDT',
    };
    mockStorage.set('alerts', [alertT16, alertT17]);

    const closeOrderCalls: any[] = [];
    const { ExchangeManager } = await import('../../src/exchanges');
    const customProvider = {
      enforceProtectionCheck: true,
      usesBeforeOrderDispatch: true,
      fetchTicker: vi.fn().mockResolvedValue({ symbol: 'BTCUSDT', last: 50100, bid: 50090, ask: 50110 }),
      fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 5000 }, total: { USDT: 5000 } }),
      fetchMarket: vi.fn().mockResolvedValue({
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        category: 'linear',
        precision: { price: 0.1, amount: 0.001 },
        limits: { cost: { min: 5 }, amount: { min: 0.001 } },
      }),
      fetchOrder: vi.fn().mockResolvedValue({
        id: 'ord-unprot-t16',
        status: 'closed',
        stopLoss: undefined, // Missing SL!
        takeProfit: 52000,
      }),
      fetchPositions: vi.fn().mockResolvedValue([
        {
          symbol: 'BTC/USDT',
          category: 'linear',
          positionIdx: 0,
          side: 'long',
          size: new BigNumber(0.002),
          stopLoss: undefined,
          takeProfit: 52000,
        },
      ]),
      createOrder: vi.fn().mockImplementation(async (req: any) => {
        if (typeof req.beforeOrderDispatch === 'function') {
          const rel = await req.beforeOrderDispatch();
          if (typeof rel === 'function') rel();
        }
        if (req.reduceOnly) {
          closeOrderCalls.push(req);
          throw new Error('504 Gateway Timeout during emergency close');
        }
        return {
          id: 'ord-unprot-t16',
          status: 'closed',
          filled: new BigNumber(0.002),
          amount: new BigNumber(0.002),
          average: new BigNumber(50000),
          stopLoss: undefined,
          takeProfit: undefined,
        };
      }),
      supportsOco: vi.fn().mockReturnValue(false),
    };
    (ExchangeManager.getProvider as any).mockResolvedValueOnce(customProvider).mockResolvedValueOnce(customProvider);
    (ExchangeManager.executeIdempotentOrder as any).mockImplementationOnce((p: any, r: any) => p.createOrder(r));

    const execRes = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert-unprot-t16' }),
      })
    );

    expect(execRes.status).toBe(423);
    const execBody = await execRes.json<any>();
    expect(execBody.code).toBe('UNPROTECTED_EXPOSURE_LOCK');

    // Verify reduce-only market close was dispatched with opposing side ('sell'), reduceOnly: true, positionIdx: 0
    expect(closeOrderCalls).toHaveLength(1);
    expect(closeOrderCalls[0].side).toBe('sell');
    expect(closeOrderCalls[0].reduceOnly).toBe(true);
    expect(closeOrderCalls[0].params.reduceOnly).toBe(true);
    expect(closeOrderCalls[0].params.positionIdx).toBe(0);

    // Durable lock and intents must exist in storage
    expect(mockStorage.get('lock:unprotectedExposure')).toBeDefined();
    expect(mockStorage.get('intent:protection:alert-unprot-t16')?.status).toBe('PROTECTION_FAILED');
    expect(mockStorage.get('intent:close:close_alert-unprot-t16')?.status).toBe('UNKNOWN');

    // T17: Subsequent /execute-trade on ANY symbol is blocked with HTTP 423 (UNPROTECTED_EXPOSURE_LOCK)
    const blockedRes = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert-blocked-t17' }),
      })
    );
    expect(blockedRes.status).toBe(423);
    const blockedBody = await blockedRes.json<any>();
    expect(blockedBody.code).toBe('UNPROTECTED_EXPOSURE_LOCK');
  });

  it('T18, T19, T20 & T21: Emergency-close reconciliation across DO restart, exact 5-tuple position identity check, bounded backoff + escalation at attempt 5, and lock release only on verified zero-size position', async () => {
    const nowMs = Date.now();
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', false);

    mockStorage.set('lock:unprotectedExposure', {
      positionId: 'pos-eclose-1',
      alertId: 'pos-eclose-1',
      symbol: 'BTC/USDT',
      side: 'BUY',
      category: 'linear',
      positionIdx: 0,
      closeIntentId: 'close_pos-eclose-1',
      lockedAt: nowMs - 60000,
      reason: 'Missing SL',
    });
    mockStorage.set('intent:protection:pos-eclose-1', {
      intentId: 'prot_pos-eclose-1',
      positionId: 'pos-eclose-1',
      alertId: 'pos-eclose-1',
      symbol: 'BTC/USDT',
      side: 'BUY',
      tickSize: 0.1,
      status: 'PROTECTION_FAILED',
      createdAt: nowMs - 60000,
      updatedAt: nowMs - 60000,
    });
    mockStorage.set('intent:close:close_pos-eclose-1', {
      closeIntentId: 'close_pos-eclose-1',
      positionId: 'pos-eclose-1',
      alertId: 'pos-eclose-1',
      userId: 'user-test-1',
      exchangeName: 'bybit',
      environment: 'testnet',
      symbol: 'BTC/USDT',
      category: 'linear',
      side: 'SELL',
      positionSide: 'long',
      positionIdx: 0,
      qty: '0.02',
      orderLinkId: 'eclose_pos-eclose-1',
      status: 'UNKNOWN',
      dispatchedAt: nowMs - 60000,
      attemptCount: 4, // Next failure will reach attemptCount = 5 and trigger escalation
      nextRetryAt: nowMs - 1000,
      createdAt: nowMs - 60000,
      updatedAt: nowMs - 60000,
    });

    const createOrderSpy = vi.fn();
    const { ExchangeManager } = await import('../../src/exchanges');

    // Case A (T21): Empty positions list or mismatched position identity must NOT clear lock or mark CLOSED
    (ExchangeManager.getProvider as any).mockResolvedValueOnce({
      fetchPositions: vi.fn().mockResolvedValue([
        // Mismatched symbol and positionIdx
        { symbol: 'ETH/USDT', category: 'linear', positionIdx: 0, side: 'long', size: new BigNumber(0) },
        { symbol: 'BTC/USDT', category: 'linear', positionIdx: 1, side: 'long', size: new BigNumber(0) },
      ]),
      createOrder: createOrderSpy,
    });

    // T19: Instantiate a brand-new TradingBot to verify durable reload from storage
    const restartedBot = new TradingBot(mockState, mockEnv);
    await restartedBot.alarm();

    expect(mockStorage.get('lock:unprotectedExposure')).toBeDefined();
    expect(createOrderSpy).not.toHaveBeenCalled();

    // Case B (T20): Position size > 0 and fetchOrder throws -> retains lock, does NOT resubmit order, and escalates at attemptCount >= 5
    const savedAfterA = mockStorage.get('intent:close:close_pos-eclose-1');
    expect(savedAfterA.attemptCount).toBe(5);
    savedAfterA.nextRetryAt = Date.now() - 1000;
    mockStorage.set('intent:close:close_pos-eclose-1', savedAfterA);

    const botStepB = new TradingBot(mockState, mockEnv);
    const emitSpy = vi.spyOn((botStepB as any).telemetrySink, 'emit');
    (ExchangeManager.getProvider as any).mockResolvedValueOnce({
      fetchPositions: vi.fn().mockResolvedValue([
        { symbol: 'BTC/USDT', category: 'linear', positionIdx: 0, side: 'long', size: new BigNumber(0.02) },
      ]),
      fetchOrder: vi.fn().mockRejectedValue(new Error('Bybit order lookup timeout')),
      createOrder: createOrderSpy,
    });

    await botStepB.alarm();
    expect(createOrderSpy).not.toHaveBeenCalled();
    expect(mockStorage.get('lock:unprotectedExposure')).toBeDefined();
    expect(
      emitSpy.mock.calls.some(
        (c: any[]) => c[0]?.eventName === 'EMERGENCY_CLOSE_ESCALATED_MANUAL_INTERVENTION_REQUIRED'
      )
    ).toBe(true);

    // Case C (T18 & T21): Authoritative exact 5-tuple position reports size = 0 -> marks D1 CLOSED, updates intents, and clears lock:unprotectedExposure
    const savedAfterB = mockStorage.get('intent:close:close_pos-eclose-1');
    savedAfterB.nextRetryAt = Date.now() - 1000;
    mockStorage.set('intent:close:close_pos-eclose-1', savedAfterB);

    const botStepC = new TradingBot(mockState, mockEnv);
    (ExchangeManager.getProvider as any).mockResolvedValueOnce({
      fetchPositions: vi.fn().mockResolvedValue([
        { symbol: 'BTC/USDT', category: 'linear', positionIdx: 0, side: 'long', size: new BigNumber(0) },
      ]),
      createOrder: createOrderSpy,
    });

    await botStepC.alarm();
    expect(createOrderSpy).not.toHaveBeenCalled();
    expect(mockStorage.get('lock:unprotectedExposure')).toBeUndefined();
    expect(mockStorage.get('intent:close:close_pos-eclose-1')?.status).toBe('FILLED');
    expect(mockStorage.get('intent:protection:pos-eclose-1')?.status).toBe('EMERGENCY_CLOSED');
  });

  // =========================================================================
  // T22 — Emergency-Close Flat-Position Reconciliation & Pagination Safety
  // =========================================================================
  it('T22: reconciles Bybit one-way zero-size position (side="", size="0") to FILLED and fails closed on incomplete paginated response', async () => {
    const adapter = new BybitAdapter();
    await adapter.connect({
      apiKey: 'bybit_key',
      secret: 'bybit_secret',
      environment: 'testnet',
    } as any);
    vi.spyOn(adapter as any, 'getSyncedTimestamp').mockResolvedValue('1700000000000');

    const requestedUrls: string[] = [];
    vi.spyOn(adapter as any, 'fetchWithTimeout').mockImplementation(async (url: string) => {
      requestedUrls.push(url);
      return new Response(
        JSON.stringify({
          retCode: 0,
          result: {
            list: [
              {
                symbol: 'BTCUSDT',
                side: '',
                size: '0',
                positionIdx: 0,
                avgPrice: '0',
                markPrice: '50100',
                leverage: '5',
                unrealisedPnl: '0',
                liqPrice: '0',
                positionIM: '0',
              },
            ],
            nextPageCursor: '',
          },
        }),
        { status: 200 }
      );
    });

    const zeroPositions = await adapter.fetchPositions('linear', 'BTC/USDT', true);
    expect(requestedUrls[0]).toContain('category=linear');
    expect(requestedUrls[0]).toContain('symbol=BTCUSDT');
    expect(requestedUrls[0]).not.toContain('settleCoin=');
    expect(zeroPositions).toHaveLength(1);
    expect(zeroPositions[0].side).toBe('none');
    expect(zeroPositions[0].size.toNumber()).toBe(0);

    // Verify TradingBot emergency close reconciliation matches the one-way flat row (side: 'none', positionIdx: 0, size: 0)
    const nowMs = Date.now();
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', false);
    mockStorage.set('lock:unprotectedExposure', {
      positionId: 'pos-t22-1',
      alertId: 'pos-t22-1',
      symbol: 'BTC/USDT',
      reason: 'EMERGENCY_CLOSE_PENDING',
      lockedAt: nowMs - 10000,
    });
    mockStorage.set('intent:protection:pos-t22-1', {
      positionId: 'pos-t22-1',
      alertId: 'pos-t22-1',
      symbol: 'BTC/USDT',
      side: 'BUY',
      tickSize: 0.1,
      status: 'PROTECTION_FAILED',
      createdAt: nowMs - 10000,
      updatedAt: nowMs - 10000,
    });
    mockStorage.set('intent:close:close_pos-t22-1', {
      closeIntentId: 'close_pos-t22-1',
      positionId: 'pos-t22-1',
      alertId: 'pos-t22-1',
      userId: 'user-test-1',
      exchangeName: 'bybit',
      environment: 'testnet',
      symbol: 'BTC/USDT',
      category: 'linear',
      side: 'SELL',
      positionSide: 'long',
      positionIdx: 0,
      qty: '0.02',
      orderLinkId: 'eclose_pos-t22-1',
      status: 'DISPATCHED',
      dispatchedAt: nowMs - 10000,
      attemptCount: 1,
      nextRetryAt: nowMs - 1000,
      createdAt: nowMs - 10000,
      updatedAt: nowMs - 10000,
    });

    const { ExchangeManager } = await import('../../src/exchanges');
    (ExchangeManager.getProvider as any).mockResolvedValueOnce(adapter);

    const bot = new TradingBot(mockState, mockEnv);
    await bot.alarm();

    expect(mockStorage.get('lock:unprotectedExposure')).toBeUndefined();
    expect(mockStorage.get('intent:close:close_pos-t22-1')?.status).toBe('FILLED');
    expect(mockStorage.get('intent:protection:pos-t22-1')?.status).toBe('EMERGENCY_CLOSED');

    // Verify pagination truncation (> 2 pages with non-empty nextPageCursor) throws EXCHANGE_RESPONSE_INCOMPLETE
    vi.spyOn(adapter as any, 'fetchWithTimeout').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          retCode: 0,
          result: {
            list: [
              {
                symbol: 'ETHUSDT',
                side: 'Buy',
                size: '1',
                positionIdx: 0,
              },
            ],
            nextPageCursor: 'cursor_still_remaining',
          },
        }),
        { status: 200 }
      )
    );

    await expect(adapter.fetchPositions('linear')).rejects.toMatchObject({ code: 'EXCHANGE_RESPONSE_INCOMPLETE' });
  });

  // =========================================================================
  // T23 — Order-History Fallback, Status Mapping & Unverified Market Order Handling
  // =========================================================================
  it('T23: falls back from /v5/order/realtime to /v5/order/history, maps PartiallyFilledCanceled/Rejected, and fails closed on unverified market order', async () => {
    const adapter = new BybitAdapter();
    await adapter.connect({
      apiKey: 'bybit_key',
      secret: 'bybit_secret',
      environment: 'testnet',
    } as any);
    vi.spyOn(adapter as any, 'getSyncedTimestamp').mockResolvedValue('1700000000000');

    const requestedUrls: string[] = [];
    vi.spyOn(adapter as any, 'fetchWithTimeout').mockImplementation(async (url: string) => {
      requestedUrls.push(url);
      if (url.includes('/v5/order/realtime')) {
        return new Response(JSON.stringify({ retCode: 0, result: { list: [] } }), { status: 200 });
      }
      if (url.includes('/v5/order/history')) {
        return new Response(
          JSON.stringify({
            retCode: 0,
            result: {
              list: [
                {
                  orderId: 'exch-ord-t23',
                  orderLinkId: 'client-ord-t23',
                  symbol: 'BTCUSDT',
                  side: 'Buy',
                  orderType: 'Market',
                  orderStatus: 'PartiallyFilledCanceled',
                  qty: '0.02',
                  cumExecQty: '0.01',
                  avgPrice: '50120',
                  stopLoss: '49500',
                  takeProfit: '51200',
                  updatedTime: '1700000005000',
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ retCode: 0, result: {} }), { status: 200 });
    });

    const fetched = await adapter.fetchOrder({
      clientOrderId: 'client-ord-t23',
      symbol: 'BTC/USDT',
      category: 'linear',
    });
    expect(requestedUrls.some((u) => u.includes('/v5/order/realtime'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('/v5/order/history'))).toBe(true);
    expect(fetched.status).toBe('partially_filled');
    expect(fetched.filled.toNumber()).toBe(0.01);
    expect(Number(fetched.stopLoss)).toBe(49500);
    expect(Number(fetched.takeProfit)).toBe(51200);

    // Verify Rejected mapping in fetchClosedOrders
    vi.spyOn(adapter as any, 'fetchWithTimeout').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          retCode: 0,
          result: {
            list: [
              {
                orderId: 'rej-ord-1',
                orderLinkId: 'rej-link-1',
                symbol: 'BTCUSDT',
                side: 'Buy',
                orderType: 'Market',
                orderStatus: 'Rejected',
                qty: '0.02',
                cumExecQty: '0',
                avgPrice: '0',
                updatedTime: '1700000009000',
              },
            ],
          },
        }),
        { status: 200 }
      )
    );
    const closedOrders = await adapter.fetchClosedOrders('BTC/USDT', 10, 'linear');
    expect(closedOrders[0].status).toBe('rejected');

    // Verify /execute-trade fails closed with HTTP 502 EXECUTION_OUTCOME_AMBIGUOUS when market order verification fails and reconciliation stays DISPATCHED
    const { ExchangeManager } = await import('../../src/exchanges');
    const ambiguousAdapter = {
      fetchBalance: vi.fn().mockResolvedValue({
        free: { USDT: 5000 },
        total: { USDT: 5000 },
      }),
      fetchPositions: vi.fn().mockResolvedValue([]),
      fetchMarket: vi.fn().mockResolvedValue({
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        category: 'linear',
        precision: { price: 0.1, amount: 0.001 },
        limits: { cost: { min: 5 }, amount: { min: 0.001 } },
      }),
      fetchTicker: vi.fn().mockResolvedValue({ symbol: 'BTC/USDT', last: 50100, bid: 50090, ask: 50110 }),
      fetchOrder: vi.fn().mockRejectedValue(new Error('Order not yet visible in realtime or history')),
      fetchOpenOrders: vi.fn().mockResolvedValue([]),
      fetchClosedOrders: vi.fn().mockResolvedValue([]),
      supportsOco: vi.fn().mockReturnValue(false),
    };
    (ExchangeManager.getProvider as any).mockResolvedValueOnce(ambiguousAdapter);
    (ExchangeManager.executeIdempotentOrder as any).mockResolvedValueOnce({
      id: 'ord-ambig-1',
      clientOrderId: 'alert-ambig-1',
      symbol: 'BTC/USDT',
      type: 'market',
      side: 'buy',
      amount: new BigNumber(0.02),
      price: new BigNumber(50100),
      status: 'open',
      filled: new BigNumber(0),
      remaining: new BigNumber(0.02),
      timestamp: Date.now(),
      statusVerificationFailed: true,
    });

    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 5);
    mockStorage.set('alerts', [
      {
        id: 'alert-ambig-1',
        symbol: 'BTC/USDT',
        signalPrice: 50100,
        targetEntryPrice: 50100,
        entryPrice: 50100,
        stopLoss: 49500,
        takeProfit: 51200,
        estimatedPnl: 20,
        positionSize: 100,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 5,
        source: 'AUTONOMOUS',
      },
    ]);

    const bot = new TradingBot(mockState, mockEnv);
    const setAlarmSpy = vi.spyOn(mockState.storage, 'setAlarm');
    const resp = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert-ambig-1' }),
      })
    );

    expect(resp.status).toBe(502);
    const body: any = await resp.json();
    expect(body.code).toBe('EXECUTION_OUTCOME_AMBIGUOUS');
    expect(mockStorage.get('lock:unprotectedExposure')?.reason).toContain('could not be verified after dispatch');
    expect(setAlarmSpy).toHaveBeenCalled();
  });

  // =========================================================================
  // T24 — Safe D1 Position Reconciliation in /execute-trade and alarm()
  // =========================================================================
  it('T24: preserves non-target symbol D1 rows during /execute-trade and transitions cancelled PENDING_ENTRY to CANCELLED', async () => {
    const d1Rows: Record<string, any> = {
      'pos-sol-open': {
        id: 'pos-sol-open',
        user_id: 'user-test-1',
        symbol: 'SOL/USDT',
        side: 'BUY',
        entry_price: 150,
        quantity: 2,
        status: 'OPEN',
        entry_status: 'FILLED',
        exchange_order_id: 'exch-sol-1',
      },
      'pos-btc-pending': {
        id: 'pos-btc-pending',
        user_id: 'user-test-1',
        symbol: 'BTC/USDT',
        side: 'BUY',
        entry_price: 50000,
        quantity: 0.02,
        status: 'PENDING_ENTRY',
        entry_status: 'PENDING_ENTRY',
        exchange_order_id: 'exch-btc-pend',
      },
    };

    const customEnv = {
      ...mockEnv,
      DB: {
        prepare: vi.fn((query: string) => {
          if (query.includes('PRAGMA table_info')) {
            return {
              all: vi.fn().mockResolvedValue({
                results: [{ name: 'target_entry_price' }, { name: 'entry_status' }],
              }),
            };
          }
          return {
            bind: vi.fn((...args: any[]) => ({
              first: vi.fn().mockResolvedValue({
                exchange_name: 'bybit',
                exchange_environment: 'demo',
                exchange_region: 'global',
                exchange_api_key: 'test-key',
                exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
                exchange_api_secret_encrypted: 'sec',
              }),
              all: vi.fn().mockImplementation(async () => {
                if (query.includes('FROM trade_positions')) {
                  return {
                    results: Object.values(d1Rows).filter(
                      (r) => r.status === 'OPEN' || r.status === 'PENDING_ENTRY'
                    ),
                  };
                }
                return { results: [] };
              }),
              run: vi.fn().mockImplementation(async () => {
                if (query.includes('DELETE FROM trade_positions')) {
                  const posId = args.find((a) => typeof a === 'string' && d1Rows[a]);
                  if (posId) delete d1Rows[posId];
                } else if (query.includes("SET status = 'CANCELLED'")) {
                  const posId = args.find((a) => typeof a === 'string' && d1Rows[a]);
                  if (posId && d1Rows[posId]) d1Rows[posId].status = 'CANCELLED';
                } else if (query.includes("SET status = 'CLOSED'")) {
                  const posId = args.find((a) => typeof a === 'string' && d1Rows[a]);
                  if (posId && d1Rows[posId]) d1Rows[posId].status = 'CLOSED';
                }
                return { success: true };
              }),
            })),
          };
        }),
      },
    };

    const fetchClosedOrdersSpy = vi.fn().mockImplementation(async (symbol: string) => {
      if (String(symbol).includes('BTC')) {
        return [
          {
            id: 'exch-btc-pend',
            clientOrderId: 'pos-btc-pending',
            symbol: 'BTC/USDT',
            status: 'canceled',
            filled: new BigNumber(0),
            average: new BigNumber(0),
            timestamp: Date.now(),
          },
        ];
      }
      return [];
    });

    const { ExchangeManager } = await import('../../src/exchanges');
    (ExchangeManager.getProvider as any).mockResolvedValueOnce({
      fetchBalance: vi.fn().mockResolvedValue({
        free: { USDT: 5000 },
        total: { USDT: 5000 },
      }),
      fetchPositions: vi.fn().mockResolvedValue([]),
      fetchOpenOrders: vi.fn().mockResolvedValue([]),
      fetchClosedOrders: fetchClosedOrdersSpy,
      fetchClosedPnl: vi.fn().mockResolvedValue([]),
      fetchMarket: vi.fn().mockResolvedValue({
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        category: 'linear',
        precision: { price: 0.1, amount: 0.001 },
        limits: { cost: { min: 5 }, amount: { min: 0.001 } },
      }),
      fetchTicker: vi.fn().mockResolvedValue({ symbol: 'BTC/USDT', last: 50100, bid: 50090, ask: 50110 }),
      supportsOco: vi.fn().mockReturnValue(false),
    });
    (ExchangeManager.executeIdempotentOrder as any).mockResolvedValueOnce({
      id: 'ord-btc-new',
      status: 'closed',
      filled: { toNumber: () => 0.02 },
      amount: { toNumber: () => 0.02 },
      average: { toNumber: () => 50100 },
    });

    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 5);
    mockStorage.set('alerts', [
      {
        id: 'alert-btc-new',
        symbol: 'BTC/USDT',
        signalPrice: 50100,
        targetEntryPrice: 50100,
        entryPrice: 50100,
        stopLoss: 49500,
        takeProfit: 51200,
        estimatedPnl: 20,
        positionSize: 100,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 5,
        source: 'AUTONOMOUS',
      },
    ]);

    const bot = new TradingBot(mockState, customEnv);
    const resp = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert-btc-new' }),
      })
    );
    expect(resp.status).toBe(200);

    // Non-target SOL/USDT row MUST remain OPEN and untouched during BTC/USDT /execute-trade
    expect(d1Rows['pos-sol-open'].status).toBe('OPEN');
    expect(fetchClosedOrdersSpy.mock.calls.some((c: any[]) => String(c[0]).includes('SOL'))).toBe(false);
    // Target BTC/USDT PENDING_ENTRY row with 0 fill cancelled order MUST be deleted from D1 active positions
    expect(d1Rows['pos-btc-pending']).toBeUndefined();
  });

  // =========================================================================
  // T25 — Alarm Recovery-First Isolation, MarketDataEngine Cache Hit & Round-Robin Symbol Cap
  // =========================================================================
  it('T25: isolates alarm() recovery to MAX_RECOVERY_INTENTS_PER_ALARM=2 before scanning, hits MarketDataEngine cache, and caps scan to 3 symbols per alarm', async () => {
    const nowMs = Date.now();
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');

    for (let i = 1; i <= 3; i++) {
      mockStorage.set(`intent:order:wal-rec-${i}`, {
        intentId: `wal-rec-${i}`,
        symbol: 'BTC/USDT',
        side: 'buy',
        qty: '0.02',
        price: '50100',
        status: 'RECONCILIATION_PENDING',
        dispatchedAt: nowMs - 60000 + i * 1000,
        createdAt: nowMs - 60000 + i * 1000,
        reconciliationAttemptCount: 1,
        payloadSnapshot: {
          symbol: 'BTC/USDT',
          side: 'buy',
          qty: '0.02',
          price: '50100',
          category: 'linear',
          tickSize: 0.1,
        },
      });
    }

    const fetchTickerSpy = vi.fn().mockResolvedValue({ symbol: 'BTC/USDT', last: 50100, bid: 50090, ask: 50110 });
    const fetchKlinesSpy = vi.fn().mockImplementation(async () =>
      Array.from({ length: 100 }, (_, idx) => ({
        timestamp: Date.now() - (100 - idx) * 60000,
        open: 50000,
        high: 50200,
        low: 49900,
        close: 50100,
        volume: 100,
      }))
    );

    const { ExchangeManager } = await import('../../src/exchanges');
    (ExchangeManager.getProvider as any).mockResolvedValue({
      fetchOrder: vi.fn().mockRejectedValue(new Error('Simulated network timeout')),
      fetchOpenOrders: vi.fn().mockResolvedValue([]),
      fetchClosedOrders: vi.fn().mockResolvedValue([]),
      fetchPositions: vi.fn().mockResolvedValue([]),
      fetchTicker: fetchTickerSpy,
      fetchKlines: fetchKlinesSpy,
    });

    const bot = new TradingBot(mockState, mockEnv);
    await bot.alarm();

    // Recovery-first isolation: 0 strategy market-data calls when recovery work was processed
    expect(fetchKlinesSpy).not.toHaveBeenCalled();
    expect(mockStorage.get('intent:order:wal-rec-1')?.reconciliationAttemptCount).toBe(2);
    expect(mockStorage.get('intent:order:wal-rec-2')?.reconciliationAttemptCount).toBe(2);
    // 3rd intent deferred to next alarm because MAX_RECOVERY_INTENTS_PER_ALARM = 2
    expect(mockStorage.get('intent:order:wal-rec-3')?.reconciliationAttemptCount).toBe(1);

    // Clear WAL intents and verify normal scanning: 10 symbols -> 3 symbols per alarm + MarketDataEngine cache hit
    mockStorage.delete('intent:order:wal-rec-1');
    mockStorage.delete('intent:order:wal-rec-2');
    mockStorage.delete('intent:order:wal-rec-3');
    mockStorage.delete('lock:unprotectedExposure');

    const tenSymbols = [
      'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT',
      'ADA/USDT', 'DOGE/USDT', 'AVAX/USDT', 'DOT/USDT', 'LINK/USDT',
    ];
    mockStorage.set('monitoredSymbols', tenSymbols);
    mockStorage.set('scannerState', {
      timestamp: Date.now(),
      topOpportunities: tenSymbols.map((sym) => ({
        symbol: sym,
        state: 'ELIGIBLE',
        opportunityScore: 85,
      })),
      allQualifiedOpportunities: tenSymbols.map((sym) => ({
        symbol: sym,
        state: 'ELIGIBLE',
        opportunityScore: 85,
      })),
    });

    fetchTickerSpy.mockClear();
    (ExchangeManager.getProvider as any).mockResolvedValue({
      fetchPositions: vi.fn().mockResolvedValue([]),
      fetchOpenOrders: vi.fn().mockResolvedValue([]),
      fetchClosedOrders: vi.fn().mockResolvedValue([]),
      fetchTicker: fetchTickerSpy,
      fetchKlines: fetchKlinesSpy,
      fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 5000 }, total: { USDT: 5000 } }),
      fetchMarket: vi.fn().mockResolvedValue({
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        category: 'linear',
        precision: { price: 0.1, amount: 0.001 },
        limits: { cost: { min: 5 }, amount: { min: 0.001 } },
      }),
    });

    const scanBot = new TradingBot(mockState, mockEnv);
    await scanBot.alarm();

    // Exactly 3 symbols evaluated in 1 alarm cycle (1 fetchTicker per symbol = 3 total, 0 duplicate snapshot fetches)
    expect(fetchTickerSpy).toHaveBeenCalledTimes(3);
    expect(mockStorage.get('scanCursor')).toBe(3);
  });

  // =========================================================================
  // T26 — Fail-Closed tickSize Verification in alarm() Recovery & verifyAndEnforceProtection
  // =========================================================================
  it('T26: uses payloadSnapshot.tickSize for sub-cent SOPH/USDT recovery and fails closed when tickSize is missing or <= 0', async () => {
    const nowMs = Date.now();
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', false);
    mockStorage.set('intent:order:wal-soph-1', {
      intentId: 'wal-soph-1',
      symbol: 'SOPH/USDT',
      side: 'buy',
      qty: '500',
      price: '0.012345',
      status: 'DISPATCHED',
      dispatchedAt: nowMs - 15000,
      createdAt: nowMs - 15000,
      reconciliationAttemptCount: 0,
      payloadSnapshot: {
        symbol: 'SOPH/USDT',
        side: 'buy',
        qty: '500',
        price: '0.012345',
        stopLoss: 0.012100,
        takeProfit: 0.012900,
        category: 'linear',
        tickSize: 0.000001,
        stepSize: 1,
      },
    });

    const { ExchangeManager } = await import('../../src/exchanges');
    (ExchangeManager.getProvider as any).mockResolvedValueOnce({
      enforceProtectionCheck: true,
      fetchOrder: vi.fn().mockResolvedValue({
        id: 'exch-soph-1',
        clientOrderId: 'wal-soph-1',
        symbol: 'SOPH/USDT',
        status: 'closed',
        filled: new BigNumber(500),
        amount: new BigNumber(500),
        average: new BigNumber(0.012345),
        price: new BigNumber(0.012345),
        stopLoss: new BigNumber(0.012100),
        takeProfit: new BigNumber(0.012900),
      }),
      fetchPositions: vi.fn().mockResolvedValue([]),
      fetchOpenOrders: vi.fn().mockResolvedValue([]),
      fetchClosedOrders: vi.fn().mockResolvedValue([]),
    });

    const bot = new TradingBot(mockState, mockEnv);
    await bot.alarm();

    expect(mockStorage.get('intent:order:wal-soph-1')?.status).toBe('FILLED');
    expect(mockStorage.get('lock:unprotectedExposure')).toBeUndefined();

    // Case B: Missing tickSize in payloadSnapshot AND fetchMarket fails -> must fail closed (NOT fall back to 0.1)
    mockStorage.set('intent:order:wal-notick-1', {
      intentId: 'wal-notick-1',
      symbol: 'SOPH/USDT',
      side: 'buy',
      qty: '500',
      price: '0.012345',
      status: 'DISPATCHED',
      dispatchedAt: nowMs - 15000,
      createdAt: nowMs - 15000,
      reconciliationAttemptCount: 0,
      payloadSnapshot: {
        symbol: 'SOPH/USDT',
        side: 'buy',
        qty: '500',
        price: '0.012345',
        stopLoss: 0.012100,
        takeProfit: 0.012900,
        category: 'linear',
      },
    });

    (ExchangeManager.getProvider as any).mockResolvedValueOnce({
      enforceProtectionCheck: true,
      fetchOrder: vi.fn().mockResolvedValue({
        id: 'exch-notick-1',
        clientOrderId: 'wal-notick-1',
        symbol: 'SOPH/USDT',
        status: 'closed',
        filled: new BigNumber(500),
        amount: new BigNumber(500),
        average: new BigNumber(0.012345),
        price: new BigNumber(0.012345),
        stopLoss: new BigNumber(0.012100),
        takeProfit: new BigNumber(0.012900),
      }),
      fetchMarket: vi.fn().mockResolvedValue(null),
      fetchPositions: vi.fn().mockResolvedValue([]),
      fetchOpenOrders: vi.fn().mockResolvedValue([]),
      fetchClosedOrders: vi.fn().mockResolvedValue([]),
    });

    const botNoTick = new TradingBot(mockState, mockEnv);
    await botNoTick.alarm();

    expect(mockStorage.get('intent:order:wal-notick-1')?.status).toBe('RECONCILIATION_PENDING');
    expect(mockStorage.get('lock:unprotectedExposure')?.reason).toContain('Authoritative tickSize unavailable');

    // Case C: Direct verifyAndEnforceProtection with tickSize = 0 fails closed
    const directRes = await botNoTick.verifyAndEnforceProtection({
      provider: { enforceProtectionCheck: true, fetchPositions: vi.fn(), createOrder: vi.fn() },
      rawOrder: { id: 'ord-zero-tick', stopLoss: 0.0121, takeProfit: 0.0129 },
      userId: 'user-test-1',
      exchangeName: 'bybit',
      environment: 'testnet',
      positionId: 'pos-zero-tick',
      alertId: 'pos-zero-tick',
      symbol: 'SOPH/USDT',
      category: 'linear',
      side: 'BUY',
      filledQuantity: 500,
      expectedSL: 0.0121,
      expectedTP: 0.0129,
      tickSize: 0,
    });
    expect(directRes.verified).toBe(false);
    expect(directRes.emergencyClosed).toBe(false);
  });

  // =========================================================================
  // T27 — Deactivation Safety-Alarm Retention
  // =========================================================================
  it('T27: schedules 5s recovery alarm instead of deleteAlarm on /deactivate when pending safety work exists', async () => {
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('lock:unprotectedExposure', {
      positionId: 'pos-deact-1',
      alertId: 'pos-deact-1',
      symbol: 'BTC/USDT',
      reason: 'EMERGENCY_CLOSE_PENDING',
      lockedAt: Date.now(),
    });

    const setAlarmSpy = vi.spyOn(mockState.storage, 'setAlarm');
    const deleteAlarmSpy = vi.spyOn(mockState.storage, 'deleteAlarm');

    const bot = new TradingBot(mockState, mockEnv);
    const resp = await bot.fetch(new Request('http://bot/deactivate', { method: 'POST' }));
    expect(resp.status).toBe(200);
    const data: any = await resp.json();
    expect(data.success).toBe(true);
    expect(mockStorage.get('isActive')).toBe(false);
    expect(setAlarmSpy).toHaveBeenCalled();
    expect(deleteAlarmSpy).not.toHaveBeenCalled();
  });

  // =========================================================================
  // T28 — Discovery Subrequest Bound, Spread Filtering, Degraded 503 & Cache Isolation
  // =========================================================================
  it('T28: bounds discovery scan to <= 8 symbols, filters wide spreads via bid/ask, returns 503 on degraded klines, and isolates/invalidates cache', async () => {
    // Build 60 active linear USDT markets
    const sixtyMarkets = Array.from({ length: 60 }, (_, idx) => {
      const sym = `COIN${idx + 1}/USDT`;
      return {
        id: `COIN${idx + 1}USDT`,
        symbol: sym,
        base: `COIN${idx + 1}`,
        quote: 'USDT',
        category: 'linear',
        contractType: 'LinearPerpetual',
        active: true,
        precision: { price: 0.01, amount: 0.1 },
        limits: { cost: { min: 5 }, amount: { min: 0.1 } },
      };
    });

    // Give COIN1 a wide spread (1.0% > 0.15%) so bid/ask filtering excludes it, and COIN2..COIN20 tight spreads
    const sixtyTickers = sixtyMarkets.map((m, idx) => ({
      symbol: m.symbol,
      last: 100,
      bid: idx === 0 ? 99.0 : 99.98,
      ask: idx === 0 ? 100.0 : 100.02,
      high: 103,
      low: 97,
      volume: 50000,
      quoteVolume: (60 - idx) * 2_000_000,
      percentage: 2.5,
      timestamp: Date.now(),
    }));

    let klineCalls = 0;
    const scannedSymbols = new Set<string>();
    const mockAdapter = {
      fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 1000 }, total: { USDT: 1000 } }),
      fetchMarkets: vi.fn().mockResolvedValue(sixtyMarkets),
      fetchTickers: vi.fn().mockResolvedValue(sixtyTickers),
      fetchTicker: vi.fn().mockImplementation(async (sym: string) => ({
        symbol: sym,
        last: 100,
        bid: 99.98,
        ask: 100.02,
        high: 103,
        low: 97,
        volume: 50000,
        quoteVolume: 10_000_000,
        timestamp: Date.now(),
      })),
      fetchKlines: vi.fn().mockImplementation(async (sym: string) => {
        klineCalls++;
        scannedSymbols.add(sym);
        return Array.from({ length: 100 }, (_, i) => ({
          timestamp: Date.now() - (100 - i) * 60000,
          open: 100 + Math.sin(i) * 2,
          high: 102 + Math.sin(i) * 2,
          low: 98 + Math.sin(i) * 2,
          close: 101 + Math.sin(i) * 2,
          volume: 10000,
        }));
      }),
    };

    const { ExchangeManager } = await import('../../src/exchanges');
    (ExchangeManager.getProvider as any).mockResolvedValue(mockAdapter);

    const makeContext = (userId: string, budget?: string) => {
      let statusCode = 200;
      return {
        get: (key: string) => (key === 'jwtPayload' ? { sub: userId } : undefined),
        req: {
          query: (k: string) => (k === 'budget' ? budget : undefined),
          header: () => undefined,
        },
        env: {
          ...mockEnv,
          TRADING_BOTS: undefined,
        },
        status: (code: number) => {
          statusCode = code;
        },
        json: (body: any) =>
          new Response(JSON.stringify(body), {
            status: statusCode,
            headers: { 'Content-Type': 'application/json' },
          }),
      } as any;
    };

    const resp1 = await handleGetPersonalizedMarketCandidates(makeContext('user-disc-1', '25'));
    expect(resp1.status).toBe(200);
    // COIN1 had 1.0% spread (> 0.15%) and must have been excluded by bid/ask preservation
    expect(scannedSymbols.has('COIN1/USDT')).toBe(false);
    expect(scannedSymbols.size).toBeLessThanOrEqual(8);
    // At most 8 symbols * 4 timeframes = 32 kline calls (<= 37 total exchange calls)
    expect(klineCalls).toBeLessThanOrEqual(32);
    expect(klineCalls).toBeGreaterThan(0);

    // Budget cache isolation: querying with budget=100 must NOT hit the budget=25 cache entry
    const callsAfterFirst = klineCalls;
    const resp2 = await handleGetPersonalizedMarketCandidates(makeContext('user-disc-1', '100'));
    expect(resp2.status).toBe(200);
    expect(klineCalls).toBeGreaterThan(callsAfterFirst);

    // Cache invalidation: invalidateExchangeConnection evicts user-disc-1 entries
    await invalidateExchangeConnection(mockEnv.DB, 'user-disc-1', 'INVALID_API_KEY');
    const callsAfterInvalidation = klineCalls;
    await handleGetPersonalizedMarketCandidates(makeContext('user-disc-1', '25'));
    expect(klineCalls).toBeGreaterThan(callsAfterInvalidation);

    // Degraded 503: when kline fetches fail for all candidates (screenedCount === 0), returns HTTP 503 without caching
    mockAdapter.fetchKlines.mockRejectedValue(new Error('Bybit 429 rate limit'));
    const degradedResp = await handleGetPersonalizedMarketCandidates(makeContext('user-disc-degraded', '50'));
    expect(degradedResp.status).toBe(503);
    const degradedBody: any = await degradedResp.json();
    expect(degradedBody.code).toBe('MARKET_DATA_DEGRADED');
  });
});
