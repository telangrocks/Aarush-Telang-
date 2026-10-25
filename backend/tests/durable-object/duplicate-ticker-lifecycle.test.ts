import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot } from "../../src/trading-bot";
import BigNumber from "bignumber.js";

// Mock security crypto
vi.mock("../../src/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key"),
}));

// Mock notifications
vi.mock("../../src/handlers/notifications", () => ({
  sendTradeNotification: vi.fn().mockResolvedValue({ success: true }),
}));

let mockAdapterInstance: any;

// Mock exchanges adapter
vi.mock("../../src/exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockImplementation(() => Promise.resolve(mockAdapterInstance)),
      executeIdempotentOrder: vi.fn().mockImplementation((provider, req) => {
        if (typeof provider?.createOrder === 'function') {
          return provider.createOrder(req);
        }
        return Promise.resolve({
          id: 'ord-mock-default',
          status: 'closed',
          filled: new BigNumber(1.0),
          amount: new BigNumber(1.0),
          average: new BigNumber(50000.0),
          price: new BigNumber(50000.0),
        });
      }),
      executeIdempotentOcoOrder: vi.fn(),
    },
    normalizeEnvironment: vi.fn().mockReturnValue('testnet'),
    normalizeRegion: vi.fn().mockReturnValue('global'),
  };
});

// Mock StrategyOrchestrator prototype
const mockExecuteCycle = vi.fn();
vi.mock("../../src/engine/orchestrator/StrategyOrchestrator", () => {
  const StrategyOrchestratorMock = vi.fn();
  StrategyOrchestratorMock.prototype.setMarketDataEngine = vi.fn();
  StrategyOrchestratorMock.prototype.executeCycle = (...args: any[]) => mockExecuteCycle(...args);
  StrategyOrchestratorMock.prototype.getCurrentState = vi.fn().mockReturnValue('ACTIVE');

  return {
    StrategyOrchestrator: StrategyOrchestratorMock,
  };
});

describe("Normalized-Ticker Single-Active-or-Unresolved-Trade-Lifecycle Invariant", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = new Map();

    mockAdapterInstance = {
      fetchTicker: vi.fn().mockImplementation((sym: string) => Promise.resolve({
        symbol: sym.replace('/', ''),
        last: 50000,
        bid: 49990,
        ask: 50010,
        high: 51000,
        low: 49000,
        volume: 1000,
        quoteVolume: 50000000,
      })),
      fetchKlines: vi.fn().mockResolvedValue(
        Array.from({ length: 30 }, (_, i) => ({
          openTime: Date.now() - (30 - i) * 3600000,
          open: 49000 + i * 10,
          high: 50100 + i * 10,
          low: 48900 + i * 10,
          close: 50000 + i * 10,
          volume: 500,
        }))
      ),
      fetchBalance: vi.fn().mockResolvedValue({
        free: { USDT: 10000 },
        total: { USDT: 10000 },
      }),
      fetchMarkets: vi.fn().mockResolvedValue([
        { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 1.0 }, limits: { cost: { min: 5 }, amount: { min: 0.001 } } },
        { id: 'ETHUSDT', symbol: 'ETH/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.01 } } },
      ]),
      fetchMarket: vi.fn().mockImplementation(async (sym: string) => {
        const list = [
          { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 1.0 }, limits: { cost: { min: 5 }, amount: { min: 0.001 } } },
          { id: 'ETHUSDT', symbol: 'ETH/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.01 } } },
        ];
        return list.find(m => m.symbol === sym || m.id === sym.replace(/[\/_-]/g, '')) || null;
      }),
      fetchPositions: vi.fn().mockResolvedValue([]),
      createOrder: vi.fn().mockResolvedValue({
        id: 'ord-mock-123',
        status: 'closed',
        filled: new BigNumber(0.002),
        amount: new BigNumber(0.002),
        average: new BigNumber(50000.0),
        price: new BigNumber(50000.0),
      }),
      supportsOco: vi.fn().mockReturnValue(false),
      createOcoOrder: vi.fn(),
    };

    mockState = {
      id: { toString: () => "mock-dup-lifecycle-do-id" },
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
        }),
        setAlarm: vi.fn(),
        deleteAlarm: vi.fn(),
        list: async (opts?: any) => {
          if (opts?.prefix) {
            const m = new Map();
            for (const [k, v] of mockStorage.entries()) {
              if (k.startsWith(opts.prefix)) m.set(k, v);
            }
            return m;
          }
          return mockStorage;
        },
      },
      blockConcurrencyWhile: async (cb: any) => cb(),
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
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockResolvedValue({ success: true }),
            first: vi.fn().mockResolvedValue({
              exchange_name: 'bybit',
              exchange_environment: 'testnet',
              exchange_region: 'global',
              exchange_api_key_iv: 'iv',
              exchange_api_key_encrypted: 'enc',
              exchange_api_key_salt: 'salt',
              exchange_api_secret_encrypted: 'mock_secret',
              exchange_api_secret_iv: 'mock_iv',
            }),
          }),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({ success: true }),
          first: vi.fn().mockResolvedValue(null),
        };
      }),
    };

    mockEnv = {
      DB: mockDb,
      ENCRYPTION_KEY: "mock_key_0123456789012345678901",
      FCM_SERVER_KEY: "mock_fcm_key",
      ENVIRONMENT: "test",
      GLOBAL_TRADING_HALT: "false",
    };
  });

  // --------------------------------------------------------------------------
  // Test 1: Active Alert on BTC/USDT (ScalperV2, 5m) Suppresses Subsequent Signals
  // --------------------------------------------------------------------------
  it("Test 1: Active alert on BTC/USDT suppresses subsequent candidates across all strategies and timeframes on the same normalized ticker", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-dup-test");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 100);
    mockStorage.set("monitoredSymbols", ["BTC/USDT"]);
    mockStorage.set("lock:alarmGeneration", 1);

    // Existing active alert on BTC/USDT (<5m old)
    mockStorage.set("alerts", [
      {
        id: "alert-btc-active-1",
        symbol: "BTC/USDT",
        strategy: "ScalperV2_NEW",
        side: "BUY",
        status: "pending",
        timeframe: "5m",
        generation: 1,
        source: "AUTONOMOUS",
        timestamp: new Date().toISOString(),
      }
    ]);

    // Subsequent cycle attempts to alert Momentum on 15m for BTC/USDT
    mockExecuteCycle.mockResolvedValue([
      {
        strategyId: 'momentum',
        confidenceScore: 95,
        hasSignal: true,
        metadata: {
          targetTimeframe: '15m',
          signal: {
            type: 'BUY',
            signalPrice: 50100,
            stopLoss: 49000,
            takeProfit: 52000,
            timeframe: '15m',
            riskAssessment: { positionSizeRecommendation: 100 }
          }
        }
      }
    ]);

    await bot.alarm();

    const alerts = mockStorage.get("alerts") || [];
    // Only the pre-existing alert remains; no duplicate alert was created
    expect(alerts.length).toBe(1);
    expect(alerts[0].id).toBe("alert-btc-active-1");
  });

  // --------------------------------------------------------------------------
  // Test 2: Active Alert on BTC/USDT Does NOT Suppress Alert on ETH/USDT
  // --------------------------------------------------------------------------
  it("Test 2: Active alert on BTC/USDT does NOT suppress candidate signals for distinct ticker ETH/USDT", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-dup-test");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 100);
    mockStorage.set("monitoredSymbols", ["BTC/USDT", "ETH/USDT"]);
    mockStorage.set("lock:alarmGeneration", 1);

    mockStorage.set("alerts", [
      {
        id: "alert-btc-active-1",
        symbol: "BTC/USDT",
        strategy: "ScalperV2_NEW",
        side: "BUY",
        status: "pending",
        timeframe: "5m",
        generation: 1,
        source: "AUTONOMOUS",
        timestamp: new Date().toISOString(),
      }
    ]);

    mockExecuteCycle.mockImplementation((symbol: string) => {
      if (symbol === "BTC/USDT") {
        return Promise.resolve([
          {
            strategyId: 'momentum',
            confidenceScore: 90,
            hasSignal: true,
            metadata: {
              targetTimeframe: '15m',
              signal: {
                type: 'BUY',
                signalPrice: 50000,
                stopLoss: 49000,
                takeProfit: 52000,
                timeframe: '15m',
                riskAssessment: { positionSizeRecommendation: 100 }
              }
            }
          }
        ]);
      } else if (symbol === "ETH/USDT") {
        return Promise.resolve([
          {
            strategyId: 'momentum',
            confidenceScore: 88,
            hasSignal: true,
            metadata: {
              targetTimeframe: '15m',
              signal: {
                type: 'BUY',
                signalPrice: 3000,
                stopLoss: 2900,
                takeProfit: 3200,
                timeframe: '15m',
                riskAssessment: { positionSizeRecommendation: 100 }
              }
            }
          }
        ]);
      }
      return Promise.resolve([]);
    });

    await bot.alarm();

    const alerts = mockStorage.get("alerts") || [];
    // BTC/USDT momentum was suppressed, but ETH/USDT momentum was successfully published!
    expect(alerts.length).toBe(2);
    const ethAlert = alerts.find((a: any) => a.symbol === "ETH/USDT");
    expect(ethAlert).toBeDefined();
    expect(ethAlert.strategy).toBe("momentum_NEW");
    expect(ethAlert.status).toBe("pending");
  });

  // --------------------------------------------------------------------------
  // Test 3: Competing Concurrent Execution Requests for Same Normalized Ticker
  // --------------------------------------------------------------------------
  it("Test 3: Competing concurrent execution requests for same normalized ticker: Request 1 reserves intent, Request 2 rejected with HTTP 423", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-dup-test");
    mockStorage.set("lock:alarmGeneration", 1);

    const nowIso = new Date().toISOString();
    mockStorage.set("alerts", [
      {
        id: "alert-btc-1",
        symbol: "BTC/USDT",
        strategy: "ScalperV2_NEW",
        side: "BUY",
        status: "pending",
        timeframe: "5m",
        generation: 1,
        source: "AUTONOMOUS",
        positionSize: 100,
        signalPrice: 50000,
        targetEntryPrice: 50000,
        timestamp: nowIso,
      },
      {
        id: "alert-btc-2",
        symbol: "BTCUSDT", // Same normalized ticker!
        strategy: "Momentum_NEW",
        side: "BUY",
        status: "pending",
        timeframe: "15m",
        generation: 1,
        source: "AUTONOMOUS",
        positionSize: 100,
        signalPrice: 50000,
        targetEntryPrice: 50000,
        timestamp: nowIso,
      }
    ]);

    // Simulate Request 1 having established its atomic pre-reservation in WAL
    mockStorage.set("intent:order:alert-btc-1", {
      intentId: "alert-btc-1",
      symbol: "BTC/USDT",
      side: "buy",
      status: "INTENT_PERSISTED",
      dispatchedAt: undefined,
      createdAt: Date.now(),
      reconciliationAttemptCount: 0,
      isPreReservation: true
    });

    // Now Request 2 executes for alert-btc-2 on the same normalized symbol
    const req2 = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "alert-btc-2" })
    });

    const res2 = await bot.fetch(req2);
    expect(res2.status).toBe(423);
    const body2 = await res2.json<any>();
    expect(body2.code).toBe("CONCURRENT_EXECUTION_BLOCKED");
    expect(body2.error).toContain("alert-btc-1");
  });

  // --------------------------------------------------------------------------
  // Test 4: Pre-Dispatch Failure Safely Releases Ticker Reservation
  // --------------------------------------------------------------------------
  it("Test 4: Pre-dispatch validation failure safely transitions intent to FAILED and unlocks the ticker for future opportunities", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-dup-test");
    mockStorage.set("lock:alarmGeneration", 1);

    const nowIso = new Date().toISOString();
    mockStorage.set("alerts", [
      {
        id: "alert-invalid-size",
        symbol: "BTC/USDT",
        strategy: "ScalperV2_NEW",
        side: "BUY",
        status: "pending",
        timeframe: "5m",
        generation: 1,
        source: "AUTONOMOUS",
        positionSize: 0, // Invalid position size fails pre-dispatch validation!
        signalPrice: 50000,
        targetEntryPrice: 50000,
        timestamp: nowIso,
      }
    ]);

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "alert-invalid-size" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(400);

    // Intent must transition to FAILED with terminalReason
    const walIntent = mockStorage.get("intent:order:alert-invalid-size");
    expect(walIntent).toBeDefined();
    expect(walIntent.status).toBe("FAILED");
    expect(walIntent.terminalReason).toBe("INVALID_ALERT_POSITION_SIZE");

    // The ticker is NOT blocked; a new valid alert on BTC/USDT can now execute without 423
    mockStorage.set("alerts", [
      {
        id: "alert-btc-valid",
        symbol: "BTC/USDT",
        strategy: "ScalperV2_NEW",
        side: "BUY",
        status: "pending",
        timeframe: "5m",
        generation: 1,
        source: "AUTONOMOUS",
        positionSize: 100,
        signalPrice: 50000,
        targetEntryPrice: 50000,
        timestamp: nowIso,
      }
    ]);

    const reqValid = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "alert-btc-valid" })
    });

    const resValid = await bot.fetch(reqValid);
    // Did NOT return 423!
    expect(resValid.status).not.toBe(423);
  });

  // --------------------------------------------------------------------------
  // Test 5: Post-Dispatch Ambiguous Timeout Retains Ticker Reservation
  // --------------------------------------------------------------------------
  it("Test 5: Post-dispatch network timeout transitions intent to UNKNOWN/RECONCILIATION_PENDING and maintains ticker lock", async () => {
    // Adapter throws ambiguous network error on wire dispatch
    mockAdapterInstance.createOrder = vi.fn().mockRejectedValue(new Error("ETIMEDOUT: Connection to exchange timed out."));

    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-dup-test");
    mockStorage.set("lock:alarmGeneration", 1);

    const nowIso = new Date().toISOString();
    mockStorage.set("alerts", [
      {
        id: "alert-timeout",
        symbol: "BTC/USDT",
        strategy: "ScalperV2_NEW",
        side: "BUY",
        status: "pending",
        timeframe: "5m",
        generation: 1,
        source: "AUTONOMOUS",
        positionSize: 100,
        signalPrice: 50000,
        targetEntryPrice: 50000,
        timestamp: nowIso,
      }
    ]);

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "alert-timeout" })
    });

    const res = await bot.fetch(req);
    // Ambiguous timeout post-dispatch returns 502
    expect(res.status).toBe(502);

    // Intent must be preserved in UNKNOWN or RECONCILIATION_PENDING, NOT marked FAILED
    const walIntent = mockStorage.get("intent:order:alert-timeout");
    expect(walIntent).toBeDefined();
    expect(['UNKNOWN', 'RECONCILIATION_PENDING']).toContain(walIntent.status);

    // A competing attempt on BTC/USDT MUST be blocked with HTTP 423
    mockStorage.set("alerts", [
      ...(mockStorage.get("alerts") || []),
      {
        id: "alert-btc-competing",
        symbol: "BTC/USDT",
        strategy: "Momentum_NEW",
        side: "BUY",
        status: "pending",
        timeframe: "15m",
        generation: 1,
        source: "AUTONOMOUS",
        positionSize: 100,
        signalPrice: 50000,
        targetEntryPrice: 50000,
        timestamp: nowIso,
      }
    ]);

    const reqCompeting = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "alert-btc-competing" })
    });

    const resCompeting = await bot.fetch(reqCompeting);
    expect(resCompeting.status).toBe(423);
    const bodyCompeting = await resCompeting.json<any>();
    expect(['CONCURRENT_EXECUTION_BLOCKED', 'UNPROTECTED_EXPOSURE_LOCK']).toContain(bodyCompeting.code);
  });

  // --------------------------------------------------------------------------
  // Test 6: Confirmed Exchange Position Closure Releases Ticker for New Trades
  // --------------------------------------------------------------------------
  it("Test 6: Active position on BTC/USDT blocks new trades with HTTP 409; confirmed closure releases ticker for new trades", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-dup-test");
    mockStorage.set("lock:alarmGeneration", 1);

    // Active position exists on BTC/USDT
    mockStorage.set("activePositions", [
      {
        id: "pos-btc-open",
        symbol: "BTC/USDT",
        side: "BUY",
        status: "OPEN",
        positionSize: 100,
      }
    ]);

    const nowIso = new Date().toISOString();
    mockStorage.set("alerts", [
      {
        id: "alert-btc-while-open",
        symbol: "BTC/USDT",
        strategy: "ScalperV2_NEW",
        side: "BUY",
        status: "pending",
        timeframe: "5m",
        generation: 1,
        source: "AUTONOMOUS",
        positionSize: 100,
        signalPrice: 50000,
        targetEntryPrice: 50000,
        timestamp: nowIso,
      }
    ]);

    const reqWhileOpen = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "alert-btc-while-open" })
    });

    const resWhileOpen = await bot.fetch(reqWhileOpen);
    // Blocked with HTTP 409 SYMBOL_POSITION_CONFLICT
    expect(resWhileOpen.status).toBe(409);
    const bodyWhileOpen = await resWhileOpen.json<any>();
    expect(bodyWhileOpen.error).toBe("SYMBOL_POSITION_CONFLICT");

    // Now simulate position confirmed CLOSED on exchange and storage updated
    mockStorage.set("activePositions", []);

    mockStorage.set("alerts", [
      {
        id: "alert-btc-after-close",
        symbol: "BTC/USDT",
        strategy: "ScalperV2_NEW",
        side: "BUY",
        status: "pending",
        timeframe: "5m",
        generation: 1,
        source: "AUTONOMOUS",
        positionSize: 100,
        signalPrice: 50000,
        targetEntryPrice: 50000,
        timestamp: nowIso,
      }
    ]);

    const reqAfterClose = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "alert-btc-after-close" })
    });

    const resAfterClose = await bot.fetch(reqAfterClose);
    // No longer blocked with 409!
    expect(resAfterClose.status).not.toBe(409);
  });
});
