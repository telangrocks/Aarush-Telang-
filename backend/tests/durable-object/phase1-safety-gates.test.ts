import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot } from "../../src/trading-bot";
import { FinalDispatchSafetyGate } from "../../src/engine/safety/FinalDispatchSafetyGate";
import BigNumber from "bignumber.js";

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
        fetchTicker: vi.fn().mockImplementation((sym: string) => {
          if (sym.includes('ETH')) {
            return Promise.resolve({ symbol: 'ETHUSDT', last: 3000, bid: 2999, ask: 3001, high: 3100, low: 2900, volume: 100, quoteVolume: 300000 });
          }
          if (sym.includes('SOL')) {
            return Promise.resolve({ symbol: 'SOLUSDT', last: 150, bid: 149.9, ask: 150.1, high: 160, low: 140, volume: 100, quoteVolume: 15000 });
          }
          return Promise.resolve({ symbol: 'BTCUSDT', last: 50000, bid: 49990, ask: 50010, high: 51000, low: 49000, volume: 100, quoteVolume: 5000000 });
        }),
        fetchKlines: vi.fn().mockResolvedValue(
          Array.from({ length: 30 }, (_, i) => ({
            openTime: Date.now() - (30 - i) * 3600000,
            open: 50000,
            high: 51000,
            low: 49000,
            close: 50500,
            volume: 100
          }))
        ),
        fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 5000 }, total: { USDT: 5000 } }),
        fetchMarkets: vi.fn().mockResolvedValue([
          { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 1.0 }, limits: { cost: { min: 5 }, amount: { min: 0.001 } } },
          { id: 'ETHUSDT', symbol: 'ETH/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.01 } } },
          { id: 'SOLUSDT', symbol: 'SOL/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.1, price: 0.01 }, limits: { cost: { min: 5 }, amount: { min: 0.1 } } },
        ]),
        fetchMarket: vi.fn().mockImplementation(async (sym: string) => {
          const list = [
            { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 1.0 }, limits: { cost: { min: 5 }, amount: { min: 0.001 } } },
            { id: 'ETHUSDT', symbol: 'ETH/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.01 } } },
            { id: 'SOLUSDT', symbol: 'SOL/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.1, price: 0.01 }, limits: { cost: { min: 5 }, amount: { min: 0.1 } } },
          ];
          return list.find(m => m.symbol === sym || m.id === sym.replace('/', '')) || null;
        }),
        createOrder: vi.fn().mockResolvedValue({ id: 'ord-123', status: 'closed', filled: { toNumber: () => 0.02 }, amount: { toNumber: () => 0.02 }, average: { toNumber: () => 50000 } }),
        supportsOco: vi.fn().mockReturnValue(false),
        createOcoOrder: vi.fn()
      }),
      executeIdempotentOrder: vi.fn().mockResolvedValue({ id: 'ord-123', status: 'closed', filled: { toNumber: () => 0.02 }, amount: { toNumber: () => 0.02 }, average: { toNumber: () => 50000 } }),
      executeIdempotentOcoOrder: vi.fn()
    },
    normalizeEnvironment: vi.fn().mockReturnValue('testnet'),
    normalizeRegion: vi.fn().mockReturnValue('global'),
  };
});

// Mock the StrategyOrchestrator
const mockExecuteCycle = vi.fn();
vi.mock("../../src/engine/orchestrator/StrategyOrchestrator", () => {
  const StrategyOrchestratorMock = vi.fn();
  StrategyOrchestratorMock.prototype.setMarketDataEngine = vi.fn();
  StrategyOrchestratorMock.prototype.executeCycle = (...args: any[]) => mockExecuteCycle(...args);
  StrategyOrchestratorMock.prototype.getCurrentState = vi.fn().mockReturnValue('ACTIVE');
  return {
    StrategyOrchestrator: StrategyOrchestratorMock
  };
});

describe("Phase 1 Safety Gates: Portfolio Exposure & Same-Symbol Conflict Protection", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockDb: any;
  let dbPositions: any[];

  beforeEach(() => {
    mockStorage = new Map();
    dbPositions = [];

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
        if (query.includes('SELECT * FROM trade_positions')) {
          return {
            bind: vi.fn().mockReturnValue({
              all: vi.fn().mockResolvedValue({ results: dbPositions })
            })
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
              exchange_api_key: 'mock_api_key',
              exchange_api_secret_encrypted: 'mock_secret',
              exchange_api_secret_iv: 'mock_iv',
            })
          }),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({ success: true }),
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
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

    // Default mock cycle
    mockExecuteCycle.mockResolvedValue([
      {
        strategyId: 'scalper-v2',
        confidenceScore: 80,
        hasSignal: true,
        metadata: {
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            stopLoss: 49000,
            takeProfit: 52000,
            riskAssessment: {
              positionSizeRecommendation: 200
            }
          }
        }
      }
    ]);
  });

  // =========================================================================
  // Section 1: Same-Symbol Conflict Protection (Cases 1 - 4: Active Positions)
  // =========================================================================

  it("Case 1: Rejects incoming BUY execution when active LONG position exists on same symbol (HTTP 409)", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alert = {
      id: "alert-btc-buy",
      symbol: "BTC/USDT",
      side: "BUY" as const,
      entryPrice: 50000,
      targetEntryPrice: 50000,
      signalPrice: 50000,
      positionSize: 200,
      status: "pending" as const,
      strategy: "scalper-v2"
    };
    mockStorage.set("alerts", [alert]);
    mockStorage.set("userId", "user-p1");

    // Existing active LONG position in D1
    dbPositions.push({
      id: "pos-existing-long",
      user_id: "user-p1",
      symbol: "BTC/USDT",
      side: "BUY",
      entry_price: 49000,
      quantity: 0.01,
      status: "OPEN"
    });

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", coinId: "BTC/USDT", alertId: "alert-btc-buy" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error).toBe("SYMBOL_POSITION_CONFLICT");
    expect(body.message).toContain("An active BUY position already exists on BTC/USDT");
  });

  it("Case 2: Rejects incoming SELL execution when active LONG position exists on same symbol (HTTP 409)", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alert = {
      id: "alert-btc-sell",
      symbol: "BTC/USDT",
      side: "SELL" as const,
      entryPrice: 50000,
      targetEntryPrice: 50000,
      signalPrice: 50000,
      positionSize: 200,
      status: "pending" as const,
      strategy: "scalper-v2"
    };
    mockStorage.set("alerts", [alert]);
    mockStorage.set("userId", "user-p1");

    // Existing active LONG position in runtime activePositions and D1
    dbPositions.push({
      id: "pos-active-long",
      user_id: "user-p1",
      symbol: "BTCUSDT",
      side: "BUY",
      entry_price: 49500,
      quantity: 0.01,
      status: "OPEN"
    });
    mockStorage.set("activePositions", [{
      id: "pos-active-long",
      userId: "user-p1",
      symbol: "BTCUSDT", // Normalized test
      side: "BUY",
      entryPrice: 49500,
      quantity: 0.01,
      status: "OPEN"
    }]);

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", coinId: "BTC/USDT", alertId: "alert-btc-sell" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error).toBe("SYMBOL_POSITION_CONFLICT");
    expect(body.message).toContain("Bybit One-Way Mode forbids concurrent or conflicting positions");
  });

  it("Case 3: Rejects incoming SELL execution when active SHORT position exists on same symbol (HTTP 409)", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alert = {
      id: "alert-btc-sell-2",
      symbol: "BTC/USDT",
      side: "SELL" as const,
      entryPrice: 50000,
      targetEntryPrice: 50000,
      signalPrice: 50000,
      positionSize: 200,
      status: "pending" as const,
      strategy: "breakout"
    };
    mockStorage.set("alerts", [alert]);
    mockStorage.set("userId", "user-p1");

    // Existing active SHORT position
    dbPositions.push({
      id: "pos-existing-short",
      user_id: "user-p1",
      symbol: "BTC/USDT",
      side: "SELL",
      entry_price: 51000,
      quantity: 0.01,
      status: "OPEN"
    });

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", coinId: "BTC/USDT", alertId: "alert-btc-sell-2" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error).toBe("SYMBOL_POSITION_CONFLICT");
    expect(body.message).toContain("An active SELL position already exists");
  });

  it("Case 4: Rejects incoming BUY execution when active SHORT position exists on same symbol (HTTP 409)", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alert = {
      id: "alert-btc-buy-opp",
      symbol: "BTC/USDT",
      side: "BUY" as const,
      entryPrice: 50000,
      targetEntryPrice: 50000,
      signalPrice: 50000,
      positionSize: 200,
      status: "pending" as const,
      strategy: "momentum"
    };
    mockStorage.set("alerts", [alert]);
    mockStorage.set("userId", "user-p1");

    dbPositions.push({
      id: "pos-existing-short-2",
      user_id: "user-p1",
      symbol: "BTC/USDT",
      side: "SELL",
      entry_price: 51000,
      quantity: 0.01,
      status: "OPEN"
    });

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", coinId: "BTC/USDT", alertId: "alert-btc-buy-opp" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error).toBe("SYMBOL_POSITION_CONFLICT");
  });

  // =========================================================================
  // Section 2: In-Flight Intent Conflicts (Cases 5 & 6)
  // =========================================================================

  it("Cases 5 & 6: Rejects execution when an unresolved in-flight intent exists for the symbol (HTTP 423)", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alert = {
      id: "alert-btc-concurrent",
      symbol: "BTC/USDT",
      side: "BUY" as const,
      entryPrice: 50000,
      targetEntryPrice: 50000,
      signalPrice: 50000,
      positionSize: 200,
      status: "pending" as const,
      strategy: "scalper-v2"
    };
    mockStorage.set("alerts", [alert]);
    mockStorage.set("userId", "user-p1");

    // In-flight intent in DO storage
    mockStorage.set("intent:order:inflight-1", {
      intentId: "inflight-1",
      symbol: "BTC/USDT",
      status: "INTENT_PERSISTED",
      qty: "0.01",
      price: "50000"
    });

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", coinId: "BTC/USDT", alertId: "alert-btc-concurrent" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(423);
    const body = await res.json<any>();
    expect(body.error).toContain("Concurrent execution blocked");
  });

  // =========================================================================
  // Section 3: Level 1 Alert Generation Suppression (Case 7 & Pre-Execution)
  // =========================================================================

  it("Case 7: Level 1 suppresses new alert generation when pending alert exists for the symbol from another strategy", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    // Existing pending alert from ScalperV2 on BTC/USDT
    const existingAlert = {
      id: "existing-scalper-alert",
      symbol: "BTC/USDT",
      strategy: "scalper-v2_NEW",
      side: "BUY" as const,
      entryPrice: 50000,
      targetEntryPrice: 50000,
      signalPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 200,
      timestamp: new Date().toISOString(),
      status: "pending" as const
    };

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-p1");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 200);
    mockStorage.set("monitoredSymbols", ["BTC/USDT"]);
    mockStorage.set("alerts", [existingAlert]);

    // Mock orchestrator returns signal from ScalperV2 strategy on BTC/USDT
    mockExecuteCycle.mockResolvedValue([
      {
        strategyId: 'scalper-v2',
        confidenceScore: 85,
        hasSignal: true,
        metadata: {
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            stopLoss: 49000,
            takeProfit: 53000,
            riskAssessment: { positionSizeRecommendation: 200 }
          }
        }
      }
    ]);

    await bot.alarm();

    // Verify no second alert was added for BTC/USDT
    const alerts = mockStorage.get("alerts");
    expect(alerts.length).toBe(1);
    expect(alerts[0].id).toBe("existing-scalper-alert");
  });

  it("Level 1 suppresses alert generation when an active position already exists for the symbol", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-p1");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 200);
    mockStorage.set("monitoredSymbols", ["BTC/USDT"]);
    mockStorage.set("alerts", []);
    mockStorage.set("activePositions", [{
      id: "pos-1",
      symbol: "BTC/USDT",
      side: "BUY",
      entryPrice: 50000,
      quantity: 0.01,
      status: "OPEN"
    }]);

    await bot.alarm();

    // Alert should be suppressed because symbol has an active open position
    const alerts = mockStorage.get("alerts");
    expect(alerts.length).toBe(0);
  });

  it("Level 1 suppresses alert generation when an in-flight intent exists for the symbol", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-p1");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 200);
    mockStorage.set("monitoredSymbols", ["BTC/USDT"]);
    mockStorage.set("alerts", []);
    mockStorage.set("intent:order:intent-xyz", {
      intentId: "intent-xyz",
      symbol: "BTC/USDT",
      status: "DISPATCHED",
      qty: "0.01",
      price: "50000"
    });

    await bot.alarm();

    // Alert should be suppressed
    const alerts = mockStorage.get("alerts");
    expect(alerts.length).toBe(0);
  });

  // =========================================================================
  // Section 4: Portfolio Exposure Protection
  // =========================================================================

  it("Level 2 rejects execution when aggregate portfolio exposure exceeds maxPortfolioExposureUsdt (HTTP 409)", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alert = {
      id: "alert-eth",
      symbol: "ETH/USDT",
      side: "BUY" as const,
      entryPrice: 3000,
      targetEntryPrice: 3000,
      signalPrice: 3000,
      positionSize: 200, // Proposed: $200
      status: "pending" as const,
      strategy: "scalper-v2"
    };
    mockStorage.set("alerts", [alert]);
    mockStorage.set("userId", "user-p1");
    // Configured policy limit: $500 total exposure
    mockStorage.set("strategyConfig", { maxPortfolioExposureUsdt: 500 });
    mockStorage.set("lastAccountBalance", 5000);

    // Existing open position: 0.01 BTC at $50,000 = $500 notional
    dbPositions.push({
      id: "pos-btc",
      user_id: "user-p1",
      symbol: "BTC/USDT",
      side: "BUY",
      entry_price: 50000,
      quantity: 0.01,
      status: "OPEN"
    });

    // Current: $500. Proposed: $200. Total: $700 > Limit ($500) -> Must reject!
    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", coinId: "ETH/USDT", alertId: "alert-eth" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error).toBe("PORTFOLIO_EXPOSURE_EXCEEDED");
    expect(body.message).toContain("exceed maximum allowed");
  });

  it("Level 2 allows execution when aggregate portfolio exposure is within policy limit (HTTP 200)", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alert = {
      id: "alert-eth-ok",
      symbol: "ETH/USDT",
      side: "BUY" as const,
      entryPrice: 3000,
      targetEntryPrice: 3000,
      signalPrice: 3000,
      positionSize: 100, // Proposed: $100
      status: "pending" as const,
      strategy: "scalper-v2"
    };
    mockStorage.set("alerts", [alert]);
    mockStorage.set("userId", "user-p1");
    // Configured policy limit: $500 total exposure
    mockStorage.set("strategyConfig", { maxPortfolioExposureUsdt: 500 });
    mockStorage.set("lastAccountBalance", 5000);

    // Existing position: 1 SOL at $150 = $150 notional
    dbPositions.push({
      id: "pos-sol",
      user_id: "user-p1",
      symbol: "SOL/USDT",
      side: "BUY",
      entry_price: 150,
      quantity: 1,
      status: "OPEN"
    });

    // Current: $150. Proposed: $100. Total: $250 <= Limit ($500) -> Allowed!
    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", coinId: "ETH/USDT", alertId: "alert-eth-ok" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
  });

  it("Level 1 suppresses alert generation when aggregate exposure would exceed portfolio policy limit", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-p1");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 200);
    mockStorage.set("monitoredSymbols", ["ETH/USDT"]);
    mockStorage.set("alerts", []);
    // Policy limit: $300
    mockStorage.set("strategyConfig", { maxPortfolioExposureUsdt: 300 });

    // Existing positions total: $250
    mockStorage.set("activePositions", [{
      id: "pos-existing",
      symbol: "SOL/USDT",
      side: "BUY",
      entryPrice: 250,
      quantity: 1,
      status: "OPEN"
    }]);

    // Signal on ETH with position size 200 -> $250 + $200 = $450 > $300 limit
    mockExecuteCycle.mockResolvedValue([
      {
        strategyId: 'scalper-v2',
        confidenceScore: 80,
        hasSignal: true,
        metadata: {
          signal: {
            type: 'BUY',
            signalPrice: 3000,
            stopLoss: 2900,
            takeProfit: 3200,
            riskAssessment: { positionSizeRecommendation: 200 }
          }
        }
      }
    ]);

    await bot.alarm();

    // Alert should be suppressed at Level 1 due to portfolio exposure limit
    const alerts = mockStorage.get("alerts");
    expect(alerts.length).toBe(0);
  });

  it("FinalDispatchSafetyGate rejects orders violating maxExposure", () => {
    const req: any = {
      symbol: "BTC/USDT",
      side: "buy",
      type: "limit",
      amount: new BigNumber(0.01),
      price: new BigNumber(50000), // Notional: $500
    };

    const constraints = {
      stepSize: 0.001,
      tickSize: 1.0,
      minQty: 0.001,
      minNotional: 5,
      maxExposure: 400, // Limit is $400
      currentExposure: 0
    };

    expect(() => FinalDispatchSafetyGate.validate(req, constraints)).toThrow(
      "Order notional 500 exceeds max exposure 400"
    );
  });

  it("Level 2 allows high allocation ($50,000) when account balance is sufficient ($100,000) and no artificial $1,000 cap blocks it", async () => {
    const exchangesMock = await import("../../src/exchanges");
    const mockProvider = await exchangesMock.ExchangeManager.getProvider("bybit" as any, {} as any);
    (mockProvider as any).fetchBalance = vi.fn().mockResolvedValue({ free: { USDT: 100000 }, total: { USDT: 100000 } });

    const bot = new TradingBot(mockState, mockEnv);
    const alert = {
      id: "alert-btc-50k",
      symbol: "BTC/USDT",
      side: "BUY" as const,
      entryPrice: 50000,
      targetEntryPrice: 50000,
      signalPrice: 50000,
      positionSize: 50000, // Proposed $50,000 allocation
      status: "pending" as const,
      strategy: "scalper-v2"
    };
    mockStorage.set("alerts", [alert]);
    mockStorage.set("userId", "user-p1");
    mockStorage.set("lastAccountBalance", 100000);

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", coinId: "BTC/USDT", alertId: "alert-btc-50k" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
  });

  it("Level 2 rejects $50,000 allocation when proposed notional exceeds account balance ($20,000)", async () => {
    const exchangesMock = await import("../../src/exchanges");
    const mockProvider = await exchangesMock.ExchangeManager.getProvider("bybit" as any, {} as any);
    (mockProvider as any).fetchBalance = vi.fn().mockResolvedValue({ free: { USDT: 20000 }, total: { USDT: 20000 } });

    const bot = new TradingBot(mockState, mockEnv);
    const alert = {
      id: "alert-btc-over-bal",
      symbol: "BTC/USDT",
      side: "BUY" as const,
      entryPrice: 50000,
      targetEntryPrice: 50000,
      signalPrice: 50000,
      positionSize: 50000, // Proposed $50,000
      status: "pending" as const,
      strategy: "scalper-v2"
    };
    mockStorage.set("alerts", [alert]);
    mockStorage.set("userId", "user-p1");
    mockStorage.set("lastAccountBalance", 20000);

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", coinId: "BTC/USDT", alertId: "alert-btc-over-bal" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error).toBe("PORTFOLIO_EXPOSURE_EXCEEDED");
    expect(body.message).toContain("Aggregate portfolio exposure");
  });

  it("Level 2 fails closed with HTTP 409 when account balance is unverified or zero", async () => {
    const exchangesMock = await import("../../src/exchanges");
    const mockProvider = await exchangesMock.ExchangeManager.getProvider("bybit" as any, {} as any);
    (mockProvider as any).fetchBalance = vi.fn().mockRejectedValue(new Error("Exchange balance unverified"));

    const bot = new TradingBot(mockState, mockEnv);
    const alert = {
      id: "alert-btc-nobal",
      symbol: "BTC/USDT",
      side: "BUY" as const,
      entryPrice: 50000,
      targetEntryPrice: 50000,
      signalPrice: 50000,
      positionSize: 100,
      status: "pending" as const,
      strategy: "scalper-v2"
    };
    mockStorage.set("alerts", [alert]);
    mockStorage.set("userId", "user-p1");
    mockStorage.set("lastAccountBalance", 0);

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", coinId: "BTC/USDT", alertId: "alert-btc-nobal" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error).toBe("PORTFOLIO_EXPOSURE_EXCEEDED");
  });

  it("Level 2 confirms explicit exposure limit cannot bypass live balance when balance is zero", async () => {
    const exchangesMock = await import("../../src/exchanges");
    const mockProvider = await exchangesMock.ExchangeManager.getProvider("bybit" as any, {} as any);
    (mockProvider as any).fetchBalance = vi.fn().mockRejectedValue(new Error("Exchange balance unverified"));

    const bot = new TradingBot(mockState, mockEnv);
    const alert = {
      id: "alert-btc-bypass-attempt",
      symbol: "BTC/USDT",
      side: "BUY" as const,
      entryPrice: 50000,
      targetEntryPrice: 50000,
      signalPrice: 50000,
      positionSize: 100,
      status: "pending" as const,
      strategy: "scalper-v2"
    };
    mockStorage.set("alerts", [alert]);
    mockStorage.set("userId", "user-p1");
    mockStorage.set("lastAccountBalance", 0);
    // Explicit limit attempted to bypass live zero balance
    mockStorage.set("strategyConfig", { maxPortfolioExposureUsdt: 50000 });

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", coinId: "BTC/USDT", alertId: "alert-btc-bypass-attempt" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error).toBe("PORTFOLIO_EXPOSURE_EXCEEDED");
  });

  it("Level 2 fails closed with HTTP 400 INVALID_ALERT_POSITION_SIZE when target.positionSize is invalid or zero", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alert = {
      id: "alert-btc-nosize",
      symbol: "BTC/USDT",
      side: "BUY" as const,
      entryPrice: 50000,
      targetEntryPrice: 50000,
      signalPrice: 50000,
      positionSize: 0, // Invalid size
      status: "pending" as const,
      strategy: "scalper-v2"
    };
    mockStorage.set("alerts", [alert]);
    mockStorage.set("userId", "user-p1");
    mockStorage.set("lastAccountBalance", 50000);

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", coinId: "BTC/USDT", alertId: "alert-btc-nosize" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error).toBe("INVALID_ALERT_POSITION_SIZE");
  });

  it("/execute legacy route fails closed with HTTP 400 MISSING_POSITION_SIZE when position size is missing or <= 0", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "user-p1");
    mockStorage.set("coinId", "BTC/USDT");
    mockStorage.set("strategy", "scalper-v2");

    const req = new Request("http://bot/mock-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", symbol: "BTC/USDT", strategy: "scalper-v2", positionSizeUsdt: 0 })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error).toBe("MISSING_POSITION_SIZE");
  });

  // =========================================================================
  // Section 5: Independent Symbols Non-Interference & Symbol Normalization
  // =========================================================================

  it("Independent symbols do not block each other: active BTC position does not block ETH execution", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alertEth = {
      id: "alert-eth-indep",
      symbol: "ETH/USDT",
      side: "BUY" as const,
      entryPrice: 3000,
      targetEntryPrice: 3000,
      signalPrice: 3000,
      positionSize: 100,
      status: "pending" as const,
      strategy: "scalper-v2"
    };
    mockStorage.set("alerts", [alertEth]);
    mockStorage.set("userId", "user-p1");
    mockStorage.set("lastAccountBalance", 10000);

    // Active position on BTC
    dbPositions.push({
      id: "pos-btc-indep",
      user_id: "user-p1",
      symbol: "BTC/USDT",
      side: "BUY",
      entry_price: 50000,
      quantity: 0.01,
      status: "OPEN"
    });

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p1", coinId: "ETH/USDT", alertId: "alert-eth-indep" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
  });

  it("Symbol normalization handles delimiter and casing variations accurately", () => {
    const bot = new TradingBot(mockState, mockEnv);
    expect(bot.normalizeSymbol("BTC/USDT")).toBe("BTCUSDT");
    expect(bot.normalizeSymbol("btcusdt")).toBe("BTCUSDT");
    expect(bot.normalizeSymbol("btc/usdt")).toBe("BTCUSDT");
    expect(bot.normalizeSymbol("BTC-USDT")).toBe("BTCUSDT");
    expect(bot.normalizeSymbol("btc_usdt")).toBe("BTCUSDT");
    expect(bot.normalizeSymbol("  SOL/USDT  ")).toBe("SOLUSDT");
  });
});
