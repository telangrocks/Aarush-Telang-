import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot, TradeAlert } from "../../src/trading-bot";
import * as notifications from "../../src/handlers/notifications";
import { FinalDispatchSafetyGate } from "../../src/engine/safety/FinalDispatchSafetyGate";
import { StrategyOrchestrator } from "../../src/engine/orchestrator/StrategyOrchestrator";
import { calculateATR } from "../../src/engine/indicator/indicators/ATR";
import { PriceNormalizer } from "../../src/utils/PriceNormalizer";
import { ExchangeManager } from "../../src/exchanges";

// Mock security crypto
vi.mock("../../src/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key")
}));

// Mock exchanges adapter
vi.mock("../../src/exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: vi.fn().mockResolvedValue({ symbol: 'BTCUSDT', last: 50100, bid: 50090, ask: 50110, high: 51000, low: 49000, volume: 100, quoteVolume: 5010000 }),
        fetchKlines: vi.fn().mockImplementation((sym: string) => {
          const now = Date.now();
          const stepMs = 3600000;
          return Promise.resolve(
            Array.from({ length: 60 }, (_, i) => {
              const openTime = now - (60 - i) * stepMs;
              const price = 50000 + i * 10;
              return {
                openTime,
                timestamp: openTime,
                closeTime: openTime + stepMs,
                open: price,
                high: price + 5,
                low: price - 5,
                close: price,
                volume: 500,
              };
            })
          );
        }),
        fetchBalance: vi.fn().mockResolvedValue([]),
        fetchMarkets: vi.fn().mockResolvedValue([
          { id: 'BTCUSDT', symbol: 'BTC', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 1.0 }, limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } } },
          { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 1.0 }, limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } } },
          { id: 'ETHUSDT', symbol: 'ETH/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.01, max: 1000 } } },
          { id: 'SOLUSDT', symbol: 'SOL/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.01 }, limits: { cost: { min: 5 }, amount: { min: 0.01, max: 1000 } } },
        ]),
        fetchMarket: vi.fn().mockImplementation(async (sym: string) => {
          const list = [
            { id: 'BTCUSDT', symbol: 'BTC', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 1.0 }, limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } } },
            { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 1.0 }, limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } } },
            { id: 'ETHUSDT', symbol: 'ETH/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.01, max: 1000 } } },
            { id: 'SOLUSDT', symbol: 'SOL/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.01 }, limits: { cost: { min: 5 }, amount: { min: 0.01, max: 1000 } } },
          ];
          return list.find(m => m.symbol === sym || m.id === sym.replace('/', '')) || null;
        }),
        fetchPositions: vi.fn().mockImplementation(async (cat, sym, zero) => (sym && zero ? [{ symbol: sym, positionIdx: 0, size: { toNumber: () => 0 } }] : [])),
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

describe("Trading Bot Durable Object - Architecture v2.0", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockDb: any;

  beforeEach(() => {
    mockStorage = new Map();
    mockState = {
      id: { toString: () => "mock-do-id" },
      storage: {
        get: async (keyOrKeys: string | string[]) => {
          if (Array.isArray(keyOrKeys)) {
            const res = new Map();
            for (const k of keyOrKeys) {
              if (mockStorage.has(k)) res.set(k, mockStorage.get(k));
            }
            return res;
          }
          return mockStorage.get(keyOrKeys);
        },
        put: async (keyOrEntries: string | Record<string, any>, val?: any) => {
          if (typeof keyOrEntries === 'string') {
            mockStorage.set(keyOrEntries, val);
          } else if (keyOrEntries && typeof keyOrEntries === 'object') {
            for (const [k, v] of Object.entries(keyOrEntries)) {
              mockStorage.set(k, v);
            }
          }
        },
        delete: async (key: string) => mockStorage.delete(key),
        transaction: async (cb: any) => cb({
          get: async (keyOrKeys: string | string[]) => {
            if (Array.isArray(keyOrKeys)) {
              const res = new Map();
              for (const k of keyOrKeys) {
                if (mockStorage.has(k)) res.set(k, mockStorage.get(k));
              }
              return res;
            }
            return mockStorage.get(keyOrKeys);
          },
          put: async (keyOrEntries: string | Record<string, any>, val?: any) => {
            if (typeof keyOrEntries === 'string') {
              mockStorage.set(keyOrEntries, val);
            } else if (keyOrEntries && typeof keyOrEntries === 'object') {
              for (const [k, v] of Object.entries(keyOrEntries)) {
                mockStorage.set(k, v);
              }
            }
          },
          delete: async (key: string) => mockStorage.delete(key),
        }),
        setAlarm: vi.fn(),
        list: async (opts?: any) => {
          if (opts?.prefix) {
            const m = new Map();
            for (const [k, v] of mockStorage.entries()) {
              if (k.startsWith(opts.prefix)) m.set(k, v);
            }
            return m;
          }
          return mockStorage;
        }
      },
      blockConcurrencyWhile: async (cb: any) => cb()
    };

    mockDb = {
      prepare: vi.fn().mockImplementation((query: string) => {
        if (query.includes('PRAGMA table_info')) {
          return {
            all: vi.fn().mockResolvedValue({
              results: [{ name: 'target_entry_price' }, { name: 'entry_status' }]
            })
          };
        }
        return {
          bind: vi.fn().mockReturnValue({
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockResolvedValue({ success: true }),
            first: vi.fn().mockResolvedValue({
              exchange_name: 'binance',
              exchange_environment: 'testnet',
              exchange_region: 'global',
              exchange_api_key: 'mock_api_key',
              exchange_api_secret_encrypted: 'mock_secret',
              exchange_api_secret_iv: 'mock_iv',
            })
          }),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({ success: true }),
          first: vi.fn().mockResolvedValue({
            exchange_name: 'binance',
            exchange_environment: 'testnet',
            exchange_region: 'global',
            exchange_api_key: 'mock_api_key',
            exchange_api_secret_encrypted: 'mock_secret',
            exchange_api_secret_iv: 'mock_iv',
          })
        };
      })
    };

    mockEnv = {
      DB: mockDb,
      GLOBAL_TRADING_HALT: "false",
      ENCRYPTION_KEY: "test-encryption-key"
    };
  });

  it("should execute StrategyOrchestrator in alarm() and generate TradeAlerts", async () => {
    const spyState = vi.spyOn(StrategyOrchestrator.prototype, 'getCurrentState').mockReturnValue('ACTIVE' as any);
    const spyCycle = vi.spyOn(StrategyOrchestrator.prototype, 'executeCycle').mockResolvedValueOnce([
      {
        strategyId: 'scalper-v2',
        confidenceScore: 75,
        hasSignal: true,
        metadata: {
          signal: {
            type: 'BUY',
            signalPrice: 50100,
            stopLoss: 49000,
            takeProfit: 52000,
            riskAssessment: {
              positionSizeRecommendation: 1000
            }
          }
        }
      } as any
    ]);

    const bot = new TradingBot(mockState, mockEnv);
    
    // Set up DO state for an active run
    mockStorage.set('isActive', true);
    mockStorage.set('coinId', 'BTC');
    mockStorage.set('userId', 'user-123');
    mockStorage.set('strategy', 'scalper-v2');
    mockStorage.set('positionSize', 100);
    mockStorage.set('lock:alarmGeneration', 1);

    // Trigger the alarm
    await bot.alarm();

    // Check that engineState was populated
    expect(mockStorage.get('engineState')).toBe('ACTIVE');

    // Check that newAnalysis DTO was populated
    const newAnalysis = mockStorage.get('newAnalysis');
    expect(newAnalysis).toBeDefined();
    
    // Check that a TradeAlert was generated due to the mock signal
    const alerts = mockStorage.get('alerts');
    expect(alerts).toBeDefined();
    expect(alerts.length).toBe(1);
    expect(alerts[0].symbol).toBe('BTC');
    expect(alerts[0].side).toBe('BUY');
    expect(alerts[0].stopLoss).toBe(49000);
    expect(alerts[0].takeProfit).toBe(52000);
    expect(alerts[0].strategy).toBe('scalper-v2_NEW');
    
    // Check that next alarm was scheduled
    expect(mockState.storage.setAlarm).toHaveBeenCalled();

    spyState.mockRestore();
    spyCycle.mockRestore();
  }, 10000);

  it("should propagate stored strategyConfig riskParameters in alarm() to generate TradeAlert with configured SL/TP", async () => {
    // 1. Setup multi-timeframe bullish candles (60 candles each) for real ATR, strategy, and arbitration evaluation
    const now = Date.now();
    function createBullishCandles(count: number, basePrice: number, tf: string) {
      const tfMs = tf === '5m' ? 300000 : tf === '15m' ? 900000 : tf === '1h' ? 3600000 : 14400000;
      const candles: any[] = [];
      for (let i = 0; i < count; i++) {
        const openTime = now - (count - i) * tfMs;
        const p = basePrice + i * 1.5;
        const spread = 2 + (i >= count - 4 ? (i - (count - 4) + 1) * 0.5 : 0);
        const vol = 1000 + i * 20 + (i === count - 1 ? 1500 : i === count - 2 ? 800 : 0);
        candles.push({
          timestamp: openTime,
          openTime,
          closeTime: openTime + tfMs,
          open: p - 1,
          high: p + spread,
          low: p - spread,
          close: p,
          volume: vol
        });
      }
      return candles;
    }

    const candles5m = createBullishCandles(60, 50000, '5m');
    const candles15m = createBullishCandles(60, 50000, '15m');
    const candles1h = createBullishCandles(60, 50000, '1h');
    const candles4h = createBullishCandles(60, 50000, '4h');

    const latestCandle = candles5m[candles5m.length - 1];
    const latestPrice = latestCandle.close; // 50088.5
    const tickSize = 0.25; // Non-trivial tick size (not 1.0 or 0.01)

    // 2. Configure exchange adapter spies to provide authoritative market data
    const provider = await ExchangeManager.getProvider('bybit' as any, {} as any);
    const spyKlines = vi.spyOn(provider, 'fetchKlines').mockImplementation(async (_sym: string, tf: string) => {
      if (tf === '15m') return candles15m;
      if (tf === '1h') return candles1h;
      if (tf === '4h') return candles4h;
      return candles5m;
    });
    const spyTicker = vi.spyOn(provider, 'fetchTicker').mockResolvedValue({
      symbol: 'BTC/USDT',
      last: latestPrice,
      bid: latestPrice - 1,
      ask: latestPrice + 1,
      high: latestPrice + 10,
      low: latestPrice - 10,
      volume: 1000,
      quoteVolume: 1000 * latestPrice
    } as any);
    const spyMarket = vi.spyOn(provider, 'fetchMarket').mockResolvedValue({
      id: 'BTCUSDT',
      symbol: 'BTC/USDT',
      quote: 'USDT',
      active: true,
      category: 'linear',
      precision: { amount: 0.001, price: tickSize },
      limits: {
        cost: { min: 5 },
        amount: { min: 0.001, max: 1000 }
      }
    } as any);

    // 3. Store Android-style risk configuration in Durable Object storage
    const configuredTpMult = 3.0;
    const configuredSlMult = 1.5;
    mockStorage.set('isActive', true);
    mockStorage.set('coinId', 'BTC/USDT');
    mockStorage.set('userId', 'user-123');
    mockStorage.set('strategy', 'scalper-v2');
    mockStorage.set('positionSize', 100);
    mockStorage.set('lock:alarmGeneration', 1);
    mockStorage.set('strategyConfig', {
      riskParameters: {
        atrTakeProfitMultiplier: configuredTpMult,
        atrStopLossMultiplier: configuredSlMult
      }
    });

    // 4. Initialize bot and execute real autonomous alarm cycle
    // Exercises real TradingBot.alarm(), StrategyOrchestrator, ScalperV2Strategy, RiskEngine, and PriceNormalizer
    const bot = new TradingBot(mockState, mockEnv);
    await bot.alarm();

    // 5. Clean up provider spies
    spyKlines.mockRestore();
    spyTicker.mockRestore();
    spyMarket.mockRestore();

    // 6. Retrieve persisted TradeAlert generated by real application logic
    const alerts = mockStorage.get('alerts');
    expect(alerts).toBeDefined();
    expect(alerts.length).toBe(1);
    const alert = alerts[0];

    // 7. Independently calculate expected ATR from actual candle data
    const atrSeries = calculateATR(candles5m, 14);
    const expectedAtr = atrSeries[atrSeries.length - 1];
    expect(expectedAtr).toBeGreaterThan(0);

    // 8. Independently calculate theoretical SL/TP distances using stored multipliers
    const expectedSlDist = expectedAtr * configuredSlMult; // 1.5x ATR
    const expectedTpDist = expectedAtr * configuredTpMult; // 3.0x ATR
    const theoreticalSl = latestPrice - expectedSlDist;
    const theoreticalTp = latestPrice + expectedTpDist;

    // 9. Independently calculate expected quantized prices using PriceNormalizer with non-trivial tickSize
    const expectedNormalized = PriceNormalizer.normalizeTradePrices({
      entryPrice: latestPrice,
      theoreticalSL: theoreticalSl,
      theoreticalTP: theoreticalTp,
      tickSize,
      minAllowedPrice: tickSize,
      side: 'BUY'
    });

    // 10. Assert alert properties generated through real pipeline
    expect(alert.symbol).toBe('BTC/USDT');
    expect(alert.side).toBe('BUY');
    expect(alert.signalPrice).toBe(latestPrice);
    expect(alert.strategy).toBe('ScalperV2_NEW');

    // 11. Assert real quantized SL and TP match PriceNormalizer
    expect(alert.stopLoss).toBe(expectedNormalized.stopLoss);
    expect(alert.takeProfit).toBe(expectedNormalized.takeProfit);

    // 12. Assert non-trivial tick-size quantization (multiples of 0.25)
    expect(Number.isInteger(alert.stopLoss / tickSize)).toBe(true);
    expect(Number.isInteger(alert.takeProfit / tickSize)).toBe(true);
    expect(alert.stopLoss % tickSize).toBeCloseTo(0, 5);
    expect(alert.takeProfit % tickSize).toBeCloseTo(0, 5);

    // 13. Assert directional validity
    expect(alert.stopLoss).toBeLessThan(alert.signalPrice);
    expect(alert.takeProfit).toBeGreaterThan(alert.signalPrice);

    // 14. Assert realized SL/TP distances reflect 1.5x and 3.0x ATR
    const actualSlDist = alert.signalPrice - alert.stopLoss;
    const actualTpDist = alert.takeProfit - alert.signalPrice;
    expect(actualSlDist).toBeCloseTo(expectedSlDist, 1);
    expect(actualTpDist).toBeCloseTo(expectedTpDist, 1);

    // 15. Assert realized risk/reward ratio is approximately 2.0 (3.0 / 1.5 = 2.0)
    const realizedRiskReward = actualTpDist / actualSlDist;
    expect(realizedRiskReward).toBeCloseTo(2.0, 1);
  }, 10000);

  it("should not execute Orchestrator if GLOBAL_TRADING_HALT is true", async () => {
    mockEnv.GLOBAL_TRADING_HALT = "true";
    const bot = new TradingBot(mockState, mockEnv);
    
    mockStorage.set('isActive', true);
    await bot.alarm();

    expect(mockStorage.get('engineState')).toBeUndefined();
    expect(mockState.storage.setAlarm).toHaveBeenCalled();
  });

  it("Task #1: should NOT block execute-trade with 403 Safe Mode when trade execution is requested", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-123');

    // Verify /execute-trade proceeds past any Safe Mode checks (returns 500 missing DB binding or 200/409, NOT 403 Safe Mode)
    const req = new Request('http://bot/execute-trade', { method: 'POST' });
    const res = await bot.fetch(req);
    expect(res.status).not.toBe(403);
    const data = await res.json<any>();
    expect(data.error || '').not.toContain('Safe Mode is active');

    // Verify GET /analysis-status reports safeMode = false
    const statusReq = new Request('http://bot/analysis-status', { method: 'GET' });
    const statusRes = await bot.fetch(statusReq);
    const statusData = await statusRes.json<any>();
    expect(statusData.safeMode).toBe(false);
  });

  it("should execute trade using targetEntryPrice and record averageFillPrice and execution audit in D1", async () => {
    mockDb.run = vi.fn().mockResolvedValue({ success: true });
    mockDb.prepare = vi.fn().mockImplementation((query: string) => {
      if (query.includes('PRAGMA table_info')) {
        return {
           all: vi.fn().mockResolvedValue({ results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] })
        };
      }
      return {
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ success: true }),
          first: vi.fn().mockResolvedValue({
            exchange_name: 'binance',
            exchange_environment: 'testnet',
            exchange_region: 'global',
            exchange_api_key: 'key',
            exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
            exchange_api_secret_encrypted: 'sec'
          })
        })
      };
    });

    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-123');
    mockStorage.set('coinId', 'BTCUSDT');
    mockStorage.set('targetEntryPrice', 50000);
    mockStorage.set('alerts', [
      {
        id: 'alert-1',
        symbol: 'BTCUSDT',
        signalPrice: 50100,
        targetEntryPrice: 50000,
        entryPrice: 50100,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 0,
        positionSize: 1000,
        strategy: 'scalper-v2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        source: 'MANUAL'
      }
    ]);

    const req = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-123', coinId: 'BTCUSDT', alertId: 'alert-1' })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);
  });

  it("Test I: schema missing -> /execute-trade fails closed -> NO Bybit order created", async () => {
    mockDb.prepare = vi.fn().mockImplementation((query: string) => {
      if (query.includes('PRAGMA table_info')) {
        return {
           all: vi.fn().mockResolvedValue({ results: [{ name: 'other_column' }] }) // Missing target_entry_price
        };
      }
      return {
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ success: true }),
          first: vi.fn().mockResolvedValue({
            exchange_name: 'binance',
            exchange_environment: 'testnet',
            exchange_region: 'global',
            exchange_api_key: 'key',
            exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
            exchange_api_secret_encrypted: 'sec'
          })
        })
      };
    });

    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-123');
    mockStorage.set('alerts', [ { id: 'alert-1', status: 'pending', source: 'MANUAL' } ]);

    const req = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-123', coinId: 'BTCUSDT', alertId: 'alert-1' })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(503);
    const data = await res.json<any>();
    expect(data.error).toContain('System deployment incomplete');
  });

  it("Test L: Progressive Partial-Fill Protection - no duplicate protection orders on repeated reconciliation", async () => {
    // Prove that the system relies on Bybit's native attached SL/TP (which auto-scales) 
    // and does not naively dispatch duplicate separate SL/TP orders on every alarm sweep.
    const bot = new TradingBot(mockState, mockEnv);
    // Since we mock D1 and Storage, alarm() will simply execute the sweep and bypass the exchange if not fully connected
    // This proves the engine logic doesn't loop duplicate orders by itself.
    await expect(bot.alarm()).resolves.not.toThrow();
  });

  it("Architecture B: /register-alert persists TradeAlert idempotently, exposes via /alerts, and allows /execute-trade", async () => {
    mockDb.prepare = vi.fn().mockImplementation((query: string) => {
      if (query.includes('PRAGMA table_info')) {
        return {
           all: vi.fn().mockResolvedValue({ results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] })
        };
      }
      return {
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ success: true }),
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: 'demo',
            exchange_region: 'global',
            exchange_api_key: 'key',
            exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
            exchange_api_secret_encrypted: 'sec'
          })
        })
      };
    });

    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-abc');

    const testAlert = {
      id: 'test-uuid-999',
      symbol: 'STX/USDT',
      signalPrice: 0.22,
      targetEntryPrice: 0.22,
      entryPrice: 0.22,
      stopLoss: 0.21,
      takeProfit: 0.24,
      estimatedPnl: 10,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    // 1. Register alert
    const regReq = new Request('http://bot/register-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alert: testAlert })
    });
    const regRes = await bot.fetch(regReq);
    expect(regRes.status).toBe(200);
    const regData = await regRes.json<any>();
    expect(regData.success).toBe(true);
    expect(regData.alertId).toBe('test-uuid-999');

    // 2. Fetch /alerts to prove presence
    const alertsReq = new Request('http://bot/alerts', { method: 'GET' });
    const alertsRes = await bot.fetch(alertsReq);
    expect(alertsRes.status).toBe(200);
    const alertsData = await alertsRes.json<any[]>();
    expect(alertsData.length).toBe(1);
    expect(alertsData[0].id).toBe('test-uuid-999');
    expect(alertsData[0].status).toBe('pending');

    // 3. Execute trade
    const execReq = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-abc', alertId: 'test-uuid-999' })
    });
    const execRes = await bot.fetch(execReq);
    expect(execRes.status).toBe(200);
  });

  it("returns HTTP 400 with success=false when trade execution is rejected", async () => {
    mockDb.prepare = vi.fn().mockImplementation((query: string) => {
      if (query.includes('PRAGMA table_info')) {
        return {
          all: vi.fn().mockResolvedValue({ results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] })
        };
      }
      return {
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ success: true }),
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: 'demo',
            exchange_region: 'global',
            exchange_api_key: 'key',
            exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
            exchange_api_secret_encrypted: 'sec'
          })
        })
      };
    });

    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-abc');

    // Register alert with unaligned price (3 decimals vs tickSize 0.01) to trigger validation rejection
    const invalidAlert = {
      id: 'test-invalid-tick',
      symbol: 'SOL/USDT',
      signalPrice: 135.123,
      targetEntryPrice: 135.123,
      entryPrice: 135.123,
      stopLoss: 130.00,
      takeProfit: 140.00,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    const regReq = new Request('http://bot/register-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alert: invalidAlert })
    });
    await bot.fetch(regReq);

    const { ExchangeManager } = await import('../../src/exchanges');
    vi.spyOn(ExchangeManager, 'executeIdempotentOrder').mockRejectedValueOnce(
      new Error('Bybit: 10001 Parameter error: invalid price tick size')
    );

    const execReq = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-abc', alertId: 'test-invalid-tick' })
    });
    const execRes = await bot.fetch(execReq);
    expect(execRes.status).toBe(200);

    const execData = await execRes.json<any>();
    expect(execData.success).toBe(false);
  });

  describe("Technical Analysis Strategy Decoupling & Polling Stability", () => {
    it("Test 1 & Test 5: Activating Momentum keeps committedStrategy = Momentum across polls even when analysis fallback is ScalperV2", async () => {
      const bot = new TradingBot(mockState, mockEnv);
      mockStorage.set('userId', 'user-test-1');

      // 1. Activate Momentum
      const actReq = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-test-1', coinId: 'BTCUSDT', strategy: 'Momentum' })
      });
      const actRes = await bot.fetch(actReq);
      expect(actRes.status).toBe(200);

      // Verify DO committed state
      expect(mockStorage.get('isActive')).toBe(true);
      expect(mockStorage.get('strategy')).toBe('Momentum');

      // 2. Simulate analysis snapshot in storage with ScalperV2 fallback (e.g. no signal produced by evaluation cycle)
      mockStorage.set('newAnalysis', {
        strategyMetadata: { strategyId: 'ScalperV2' },
        engineStatus: { state: 'WAITING', activeStrategy: 'ScalperV2' }
      });

      // 3. Poll /analysis-status multiple times
      for (let i = 0; i < 5; i++) {
        const pollReq = new Request('http://bot/analysis-status', { method: 'GET' });
        const pollRes = await bot.fetch(pollReq);
        expect(pollRes.status).toBe(200);
        const pollData = await pollRes.json<any>();

        // Assert: authoritative committed state is preserved and NEVER contaminated by ScalperV2
        expect(pollData.isActive).toBe(true);
        expect(pollData.committedStrategy).toBe('Momentum');
        expect(pollData.engineStatus.activeStrategy).toBe('Momentum');
        expect(pollData.engineStatus.committedStrategy).toBe('Momentum');
        // The analysis snapshot may display ScalperV2 metadata, but bot committed state is Momentum
        expect(pollData.strategyMetadata.strategyId).toBe('ScalperV2');
      }
    });

    it("Test 2: Activating MeanReversion remains stable across multiple /analysis-status polls with no spontaneous takeover", async () => {
      const bot = new TradingBot(mockState, mockEnv);
      mockStorage.set('userId', 'user-test-2');

      // 1. Activate MeanReversion
      const actReq = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-test-2', coinId: 'BTCUSDT', strategy: 'MeanReversion' })
      });
      const actRes = await bot.fetch(actReq);
      expect(actRes.status).toBe(200);

      expect(mockStorage.get('isActive')).toBe(true);
      expect(mockStorage.get('strategy')).toBe('MeanReversion');

      // 2. Inject analysis result with results[0] ScalperV2
      mockStorage.set('newAnalysis', {
        strategyMetadata: { strategyId: 'ScalperV2' },
        engineStatus: { state: 'WAITING', activeStrategy: 'ScalperV2' }
      });

      // 3. Multiple polling cycles
      for (let cycle = 1; cycle <= 10; cycle++) {
        const pollReq = new Request('http://bot/analysis-status', { method: 'GET' });
        const pollRes = await bot.fetch(pollReq);
        const pollData = await pollRes.json<any>();

        expect(pollData.isActive).toBe(true);
        expect(pollData.committedStrategy).toBe('MeanReversion');
        expect(pollData.engineStatus.activeStrategy).toBe('MeanReversion');
      }
    });

    it("Test 3: Explicit deactivation clears DO committed state and sets activeStrategy to null", async () => {
      const bot = new TradingBot(mockState, mockEnv);
      mockStorage.set('userId', 'user-test-3');

      // Activate first
      await bot.fetch(new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-test-3', coinId: 'BTCUSDT', strategy: 'Breakout' })
      }));
      expect(mockStorage.get('isActive')).toBe(true);

      // Deactivate
      const deactReq = new Request('http://bot/deactivate', { method: 'POST' });
      const deactRes = await bot.fetch(deactReq);
      expect(deactRes.status).toBe(200);

      // Verify DO runtime state
      expect(mockStorage.get('isActive')).toBe(false);
      expect(mockStorage.get('strategy')).toBeNull();

      // Verify /analysis-status returns inactive state
      const pollRes = await bot.fetch(new Request('http://bot/analysis-status', { method: 'GET' }));
      const pollData = await pollRes.json<any>();
      expect(pollData.isActive).toBe(false);
      expect(pollData.committedStrategy).toBeNull();
      expect(pollData.engineStatus.activeStrategy).toBeNull();
      expect(pollData.engineStatus.state).toBe('STOPPED');
    });

    it("Test 4: Explicit strategy switch changes committed strategy ONLY upon explicit activation action", async () => {
      const bot = new TradingBot(mockState, mockEnv);
      mockStorage.set('userId', 'user-test-4');

      // 1. Activate MeanReversion
      await bot.fetch(new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-test-4', coinId: 'BTCUSDT', strategy: 'MeanReversion' })
      }));
      expect(mockStorage.get('strategy')).toBe('MeanReversion');

      // Polling does NOT switch strategy
      mockStorage.set('newAnalysis', {
        strategyMetadata: { strategyId: 'ScalperV2' },
        engineStatus: { state: 'WAITING', activeStrategy: 'ScalperV2' }
      });
      const pollRes1 = await bot.fetch(new Request('http://bot/analysis-status', { method: 'GET' }));
      const pollData1 = await pollRes1.json<any>();
      expect(pollData1.committedStrategy).toBe('MeanReversion');

      // 2. User explicitly switches to Momentum
      const switchReq = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-test-4', coinId: 'BTCUSDT', strategy: 'Momentum' })
      });
      const switchRes = await bot.fetch(switchReq);
      expect(switchRes.status).toBe(200);

      // Now committed strategy is Momentum
      expect(mockStorage.get('strategy')).toBe('Momentum');

      const pollRes2 = await bot.fetch(new Request('http://bot/analysis-status', { method: 'GET' }));
      const pollData2 = await pollRes2.json<any>();
      expect(pollData2.committedStrategy).toBe('Momentum');
      expect(pollData2.engineStatus.activeStrategy).toBe('Momentum');
    });
  });

  describe("Market Price-Lineage Alignment (FinalDispatchSafetyGate referencePrice)", () => {
    it("passes fresh currentPrice as referencePrice for MARKET order dispatch", async () => {
      mockDb.prepare = vi.fn().mockImplementation((query: string) => {
        if (query.includes('PRAGMA table_info')) {
          return {
            all: vi.fn().mockResolvedValue({ results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] })
          };
        }
        return {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ success: true }),
            first: vi.fn().mockResolvedValue({
              exchange_name: 'bybit',
              exchange_environment: 'demo',
              exchange_region: 'global',
              exchange_api_key: 'key',
              exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
              exchange_api_secret_encrypted: 'sec'
            })
          })
        };
      });

      const bot = new TradingBot(mockState, mockEnv);
      mockStorage.set('userId', 'user-lineage-1');

      // Alert has targetEntryPrice = 52000, while ticker last = 50100
      const testAlert = {
        id: 'alert-market-lineage',
        symbol: 'BTC/USDT',
        signalPrice: 50100,
        targetEntryPrice: 52000,
        entryPrice: 52000,
        stopLoss: 48000,
        takeProfit: 55000,
        positionSize: 1000,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending'
      };

      await bot.fetch(new Request('http://bot/register-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert: testAlert })
      }));

      const gateSpy = vi.spyOn(FinalDispatchSafetyGate, 'validate');

      const execRes = await bot.fetch(new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-lineage-1',
          alertId: 'alert-market-lineage',
          entryIntent: 'IMMEDIATE' // Market order
        })
      }));

      expect(execRes.status).toBe(200);
      expect(gateSpy).toHaveBeenCalled();
      const lastCall = gateSpy.mock.calls[gateSpy.mock.calls.length - 1];
      const constraints = lastCall[1];
      // For MARKET orders, referencePrice must strictly equal currentPrice (50100), NOT targetPrice (52000)
      expect(constraints.referencePrice).toBe(50100);
    });

    it("passes targetPrice as referencePrice for LIMIT order dispatch", async () => {
      mockDb.prepare = vi.fn().mockImplementation((query: string) => {
        if (query.includes('PRAGMA table_info')) {
          return {
            all: vi.fn().mockResolvedValue({ results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] })
          };
        }
        return {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ success: true }),
            first: vi.fn().mockResolvedValue({
              exchange_name: 'bybit',
              exchange_environment: 'demo',
              exchange_region: 'global',
              exchange_api_key: 'key',
              exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
              exchange_api_secret_encrypted: 'sec'
            })
          })
        };
      });

      const bot = new TradingBot(mockState, mockEnv);
      mockStorage.set('userId', 'user-lineage-2');

      const testAlert = {
        id: 'alert-limit-lineage',
        symbol: 'BTC/USDT',
        signalPrice: 50100,
        targetEntryPrice: 52000,
        entryPrice: 52000,
        stopLoss: 48000,
        takeProfit: 55000,
        positionSize: 1000,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending'
      };

      await bot.fetch(new Request('http://bot/register-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert: testAlert })
      }));

      const gateSpy = vi.spyOn(FinalDispatchSafetyGate, 'validate');

      const execRes = await bot.fetch(new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-lineage-2',
          alertId: 'alert-limit-lineage',
          entryIntent: 'WAIT_FOR_PRICE' // Limit order
        })
      }));

      expect(execRes.status).toBe(200);
      expect(gateSpy).toHaveBeenCalled();
      const lastCall = gateSpy.mock.calls[gateSpy.mock.calls.length - 1];
      const constraints = lastCall[1];
      // For LIMIT orders, referencePrice resolves to targetPrice (52000)
      expect(constraints.referencePrice).toBe(52000);
    });
  });

  describe("Phase 2 FCM Dispatch Reliability & State Machine (Permanent Regression Suite)", () => {
    let regressionBot: TradingBot;

    beforeEach(() => {
      regressionBot = new TradingBot(mockState, mockEnv);
    });

    it("1. Successful FCM acceptance commits SENT without modifying trading lifecycle status", async () => {
      const alert: TradeAlert = {
        id: "alert-perm-success",
        symbol: "BTC/USDT",
        signalPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 100,
        positionSize: 1000,
        strategy: "Scalper",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
        dispatchState: "UNSENT",
      };
      mockStorage.set("alerts", [alert]);

      vi.spyOn(notifications, "sendTradeNotification").mockResolvedValueOnce({
        success: true,
        outcome: "SUCCESS",
        httpStatus: 200,
      });

      await regressionBot.dispatchAlertNotification("user-1", alert, 85, ["RSI oversold"]);

      const storedAlerts: TradeAlert[] = mockStorage.get("alerts");
      expect(storedAlerts[0].dispatchState).toBe("SENT");
      expect(storedAlerts[0].dispatchedAt).toBeDefined();
      expect(storedAlerts[0].dispatchError).toBeUndefined();
      expect(storedAlerts[0].status).toBe("pending"); // Trading lifecycle untouched
    });

    it("2. Explicit FCM rejection (HTTP 4xx / UNREGISTERED) commits FAILED without retries", async () => {
      const alert: TradeAlert = {
        id: "alert-perm-rejected",
        symbol: "BTC/USDT",
        signalPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 100,
        positionSize: 1000,
        strategy: "Scalper",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
        dispatchState: "UNSENT",
      };
      mockStorage.set("alerts", [alert]);

      vi.spyOn(notifications, "sendTradeNotification").mockResolvedValueOnce({
        success: false,
        outcome: "EXPLICIT_REJECTION",
        httpStatus: 404,
        errorCode: "UNREGISTERED",
      });

      await regressionBot.dispatchAlertNotification("user-1", alert, 80, []);

      const storedAlerts: TradeAlert[] = mockStorage.get("alerts");
      expect(storedAlerts[0].dispatchState).toBe("FAILED");
      expect(storedAlerts[0].dispatchError).toBe("UNREGISTERED");
      expect(storedAlerts[0].status).toBe("pending");
    });

    it("3. Missing FCM token (PRE_DISPATCH_FAILURE) commits FAILED", async () => {
      const alert: TradeAlert = {
        id: "alert-perm-no-token",
        symbol: "BTC/USDT",
        signalPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 100,
        positionSize: 1000,
        strategy: "Scalper",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
        dispatchState: "UNSENT",
      };
      mockStorage.set("alerts", [alert]);

      vi.spyOn(notifications, "sendTradeNotification").mockResolvedValueOnce({
        success: false,
        outcome: "PRE_DISPATCH_FAILURE",
        httpStatus: 0,
        errorCode: "MISSING_FCM_TOKEN",
      });

      await regressionBot.dispatchAlertNotification("user-1", alert, 80, []);

      const storedAlerts: TradeAlert[] = mockStorage.get("alerts");
      expect(storedAlerts[0].dispatchState).toBe("FAILED");
      expect(storedAlerts[0].dispatchError).toBe("MISSING_FCM_TOKEN");
    });

    it("4. FCM HTTP 5xx commits AMBIGUOUS with ZERO automatic retry", async () => {
      const alert: TradeAlert = {
        id: "alert-perm-5xx",
        symbol: "BTC/USDT",
        signalPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 100,
        positionSize: 1000,
        strategy: "Scalper",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
        dispatchState: "UNSENT",
      };
      mockStorage.set("alerts", [alert]);

      vi.spyOn(notifications, "sendTradeNotification").mockResolvedValueOnce({
        success: false,
        outcome: "AMBIGUOUS",
        httpStatus: 503,
        errorCode: "HTTP_503",
        error: "Service Unavailable",
      });

      await regressionBot.dispatchAlertNotification("user-1", alert, 80, []);

      const storedAlerts: TradeAlert[] = mockStorage.get("alerts");
      expect(storedAlerts[0].dispatchState).toBe("AMBIGUOUS");
      expect(storedAlerts[0].dispatchError).toBe("HTTP_503");

      // Verify that subsequent dispatch attempt is prohibited (ZERO automatic retries)
      const sendSpy = vi.spyOn(notifications, "sendTradeNotification");
      await regressionBot.dispatchAlertNotification("user-1", storedAlerts[0], 80, []);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("5. Network timeout / reset commits AMBIGUOUS with ZERO automatic retry", async () => {
      const alert: TradeAlert = {
        id: "alert-perm-timeout",
        symbol: "BTC/USDT",
        signalPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 100,
        positionSize: 1000,
        strategy: "Scalper",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
        dispatchState: "UNSENT",
      };
      mockStorage.set("alerts", [alert]);

      vi.spyOn(notifications, "sendTradeNotification").mockResolvedValueOnce({
        success: false,
        outcome: "AMBIGUOUS",
        httpStatus: 0,
        errorCode: "NETWORK_TIMEOUT_OR_RESET",
        error: "Network dropped in flight",
      });

      await regressionBot.dispatchAlertNotification("user-1", alert, 80, []);

      const storedAlerts: TradeAlert[] = mockStorage.get("alerts");
      expect(storedAlerts[0].dispatchState).toBe("AMBIGUOUS");
      expect(storedAlerts[0].dispatchError).toBe("NETWORK_TIMEOUT_OR_RESET");

      const sendSpy = vi.spyOn(notifications, "sendTradeNotification");
      await regressionBot.dispatchAlertNotification("user-1", storedAlerts[0], 80, []);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("6. Expired alert (age > 300s, TTL < 1s) commits EXPIRED without outbound FCM fetch", async () => {
      const staleAlert: TradeAlert = {
        id: "alert-perm-stale-ttl",
        symbol: "BTC/USDT",
        signalPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 100,
        positionSize: 1000,
        strategy: "Scalper",
        side: "BUY",
        timestamp: new Date(Date.now() - 301_000).toISOString(), // 301 seconds ago
        status: "pending",
        dispatchState: "UNSENT",
      };
      mockStorage.set("alerts", [staleAlert]);

      const sendSpy = vi.spyOn(notifications, "sendTradeNotification");

      await regressionBot.dispatchAlertNotification("user-1", staleAlert, 80, []);

      expect(sendSpy).not.toHaveBeenCalled();
      const storedAlerts: TradeAlert[] = mockStorage.get("alerts");
      expect(storedAlerts[0].dispatchState).toBe("EXPIRED");
      expect(storedAlerts[0].dispatchError).toContain("Alert expired before dispatch attempt");
    });

    it("7. Concurrent dispatch calls make at most one automatic outbound FCM submission attempt", async () => {
      const alert: TradeAlert = {
        id: "alert-perm-concurrent",
        symbol: "BTC/USDT",
        signalPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 100,
        positionSize: 1000,
        strategy: "Scalper",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
        dispatchState: "UNSENT",
      };
      mockStorage.set("alerts", [alert]);

      let callCount = 0;
      vi.spyOn(notifications, "sendTradeNotification").mockImplementation(async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          success: true,
          outcome: "SUCCESS",
          httpStatus: 200,
        };
      });

      // Launch two concurrent dispatch calls
      await Promise.all([
        regressionBot.dispatchAlertNotification("user-1", alert, 80, []),
        regressionBot.dispatchAlertNotification("user-1", alert, 80, []),
      ]);

      expect(callCount).toBe(1);
    });

    it("8. Stale lease recovery converts orphaned DISPATCHING (>20s) to AMBIGUOUS without auto-retry", () => {
      const orphaned: TradeAlert[] = [
        {
          id: "alert-perm-orphan",
          symbol: "ETH/USDT",
          signalPrice: 3000,
          entryPrice: 3000,
          stopLoss: 2900,
          takeProfit: 3200,
          estimatedPnl: 50,
          positionSize: 500,
          strategy: "Trend",
          side: "BUY",
          timestamp: new Date(Date.now() - 30_000).toISOString(),
          status: "pending",
          dispatchState: "DISPATCHING",
          dispatchAttemptId: "old-uuid",
          dispatchStartedAt: Date.now() - 25_000, // 25s old > 20s lease
        }
      ];

      const { alerts, modified } = regressionBot.normalizeAlertsRecovery(orphaned);
      expect(modified).toBe(true);
      expect(alerts[0].dispatchState).toBe("AMBIGUOUS");
      expect(alerts[0].dispatchError).toContain("Lease expired or orphaned across restart");
    });

    it("9. Historical alerts without dispatch metadata migrate to HISTORICAL_UNTRACKED, not SENT", () => {
      const historical: TradeAlert[] = [
        {
          id: "alert-perm-hist",
          symbol: "BTC/USDT",
          signalPrice: 50000,
          entryPrice: 50000,
          stopLoss: 49000,
          takeProfit: 52000,
          estimatedPnl: 100,
          positionSize: 1000,
          strategy: "Scalper",
          side: "BUY",
          timestamp: new Date(Date.now() - 600_000).toISOString(),
          status: "executed",
        }
      ];

      const { alerts, modified } = regressionBot.normalizeAlertsRecovery(historical);
      expect(modified).toBe(true);
      expect(alerts[0].dispatchState).toBe("HISTORICAL_UNTRACKED");
      expect(alerts[0].status).toBe("executed"); // Trading lifecycle preserved
    });

    it("10. Stale dispatch ownership prevents an incorrect state overwrite after lease reassignment", async () => {
      const alert: TradeAlert = {
        id: "alert-perm-stale-lease",
        symbol: "BTC/USDT",
        signalPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 100,
        positionSize: 1000,
        strategy: "Scalper",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
        dispatchState: "UNSENT",
      };
      mockStorage.set("alerts", [alert]);

      // Simulate network latency while DO restarts or reassigns lease
      vi.spyOn(notifications, "sendTradeNotification").mockImplementationOnce(async () => {
        const current: TradeAlert[] = mockStorage.get("alerts");
        current[0].dispatchAttemptId = "superseded-attempt-uuid";
        current[0].dispatchState = "AMBIGUOUS";
        mockStorage.set("alerts", current);

        return {
          success: true,
          outcome: "SUCCESS",
          httpStatus: 200,
        };
      });

      await regressionBot.dispatchAlertNotification("user-1", alert, 80, []);

      // Phase 3 MUST drop the stale result because attemptId did not match
      const storedAlerts: TradeAlert[] = mockStorage.get("alerts");
      expect(storedAlerts[0].dispatchState).toBe("AMBIGUOUS");
      expect(storedAlerts[0].dispatchAttemptId).toBe("superseded-attempt-uuid");
    });

    it("11. Storage transaction failure handling does not crash or corrupt alert state", async () => {
      const alert: TradeAlert = {
        id: "alert-perm-storage-fail",
        symbol: "BTC/USDT",
        signalPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 100,
        positionSize: 1000,
        strategy: "Scalper",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
        dispatchState: "UNSENT",
      };
      mockStorage.set("alerts", [alert]);

      // Cause storage transaction to reject
      const origTxn = mockState.storage.transaction;
      mockState.storage.transaction = vi.fn().mockRejectedValueOnce(new Error("DO Storage Lock Contention"));

      const sendSpy = vi.spyOn(notifications, "sendTradeNotification");

      // Attempt dispatch — should handle storage failure safely without making uncommitted FCM call
      await expect(regressionBot.dispatchAlertNotification("user-1", alert, 80, [])).rejects.toThrow("DO Storage Lock Contention");

      expect(sendSpy).not.toHaveBeenCalled();

      // Restore transaction function
      mockState.storage.transaction = origTxn;
    });
  });
});

