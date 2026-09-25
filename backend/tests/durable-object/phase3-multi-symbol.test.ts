import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot } from "../../src/trading-bot";
import { MarketRegimeEngine } from "../../src/engine/regime/MarketRegimeEngine";

// Mock security crypto
vi.mock("../../src/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key"),
}));

// Mock notifications
vi.mock("../../src/handlers/notifications", () => ({
  sendTradeNotification: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock exchanges adapter
vi.mock("../../src/exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: vi.fn().mockImplementation((sym: string) => Promise.resolve({
          symbol: sym.replace('/', ''),
          last: 100,
          bid: 99.9,
          ask: 100.1,
          high: 105,
          low: 95,
          volume: 1000,
          quoteVolume: 100000,
        })),
        fetchKlines: vi.fn().mockResolvedValue(
          Array.from({ length: 30 }, (_, i) => ({
            openTime: Date.now() - (30 - i) * 3600000,
            open: 98 + i * 0.1,
            high: 101 + i * 0.1,
            low: 97 + i * 0.1,
            close: 100 + i * 0.1,
            volume: 500,
          }))
        ),
        fetchBalance: vi.fn().mockResolvedValue({
          free: { USDT: 5000 },
          total: { USDT: 5000 },
        }),
        fetchMarkets: vi.fn().mockResolvedValue([
          { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 1.0 }, limits: { cost: { min: 5 }, amount: { min: 0.01 } } },
          { id: 'ETHUSDT', symbol: 'ETH/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.01 } } },
          { id: 'SOLUSDT', symbol: 'SOL/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.01 }, limits: { cost: { min: 5 }, amount: { min: 0.01 } } },
          { id: 'PASSUSDT', symbol: 'PASS/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.01 }, limits: { cost: { min: 5 }, amount: { min: 0.01 } } },
          { id: 'REGIMEACCEPTUSDT', symbol: 'REGIME_ACCEPT/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.01 }, limits: { cost: { min: 5 }, amount: { min: 0.01 } } },
          { id: 'REGIMEREJECTUSDT', symbol: 'REGIME_REJECT/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.01 }, limits: { cost: { min: 5 }, amount: { min: 0.01 } } },
        ]),
        fetchPositions: vi.fn().mockResolvedValue([]),
        createOrder: vi.fn().mockResolvedValue({
          id: 'ord-mock-123',
          status: 'closed',
          filled: { toNumber: () => 1.0 },
          amount: { toNumber: () => 1.0 },
          average: { toNumber: () => 100.0 },
        }),
        supportsOco: vi.fn().mockReturnValue(false),
        createOcoOrder: vi.fn(),
      }),
      executeIdempotentOrder: vi.fn().mockResolvedValue({
        id: 'ord-mock-123',
        status: 'closed',
        filled: { toNumber: () => 1.0 },
        amount: { toNumber: () => 1.0 },
        average: { toNumber: () => 100.0 },
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

describe("Phase 3 Multi-Symbol Monitoring & Execution", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = new Map();
    mockState = {
      id: { toString: () => "mock-p3-do-id" },
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
              exchange_api_key: 'mock_api_key',
              exchange_api_secret_encrypted: 'mock_secret',
              exchange_api_secret_iv: 'mock_iv',
            }),
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
          }),
        };
      }),
    };

    mockEnv = {
      DB: mockDb,
      GLOBAL_TRADING_HALT: "false",
      ENCRYPTION_KEY: "test-encryption-key",
    };

    // Default mock cycle: BUY signal
    mockExecuteCycle.mockResolvedValue([
      {
        strategyId: 'scalper-v2',
        confidenceScore: 85,
        hasSignal: true,
        metadata: {
          signal: {
            type: 'BUY',
            signalPrice: 100,
            stopLoss: 95,
            takeProfit: 110,
            riskAssessment: {
              positionSizeRecommendation: 200,
            },
          },
        },
      },
    ]);
  });

  // =========================================================================
  // 1. Multi-symbol activation persistence
  // =========================================================================
  it("Requirement 1: Multi-symbol activation persists monitoredSymbols and primary coinId in DO storage", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    const activateReq = new Request("http://bot/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-p3-1",
        symbols: ["SOL/USDT", "ETH/USDT", "BTC/USDT"],
        strategy: "scalper-v2",
        positionSize: 100,
      }),
    });

    const res = await bot.fetch(activateReq);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    // Verify storage persistence
    expect(mockStorage.get("isActive")).toBe(true);
    expect(mockStorage.get("monitoredSymbols")).toEqual(["SOL/USDT", "ETH/USDT", "BTC/USDT"]);
    expect(mockStorage.get("coinId")).toBe("SOL/USDT"); // primary symbol preserved for legacy callers
    expect(mockState.storage.setAlarm).toHaveBeenCalled();

    // Verify /status exposes symbols and coinId
    const statusReq = new Request("http://bot/status", { method: "GET" });
    const statusRes = await bot.fetch(statusReq);
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json<any>();
    expect(statusBody.symbols).toEqual(["SOL/USDT", "ETH/USDT", "BTC/USDT"]);
    expect(statusBody.coinId).toBe("SOL/USDT");
  });

  // =========================================================================
  // 2. Legacy coinId backward compatibility
  // =========================================================================
  it("Requirement 2: Legacy activation or stored coinId restores monitoredSymbols as [coinId]", async () => {
    // 2a. Activation with legacy coinId only (no symbols array)
    const bot = new TradingBot(mockState, mockEnv);

    const activateReq = new Request("http://bot/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-p3-2",
        coinId: "ETH/USDT",
        strategy: "scalper-v2",
        positionSize: 150,
      }),
    });

    const res = await bot.fetch(activateReq);
    expect(res.status).toBe(200);
    expect(mockStorage.get("monitoredSymbols")).toEqual(["ETH/USDT"]);
    expect(mockStorage.get("coinId")).toBe("ETH/USDT");

    // 2b. Existing DO instance with only coinId in storage
    const legacyStorage = new Map<string, any>();
    legacyStorage.set("isActive", true);
    legacyStorage.set("userId", "user-p3-legacy");
    legacyStorage.set("coinId", "BTC/USDT");
    // Explicitly no 'monitoredSymbols' key in storage
    legacyStorage.delete("monitoredSymbols");

    const legacyState = {
      ...mockState,
      storage: {
        ...mockState.storage,
        get: async (keyOrKeys: string | string[]) => {
          if (Array.isArray(keyOrKeys)) {
            const m = new Map();
            for (const k of keyOrKeys) {
              if (legacyStorage.has(k)) m.set(k, legacyStorage.get(k));
            }
            return m;
          }
          return legacyStorage.get(keyOrKeys);
        },
      },
    };

    const legacyBot = new TradingBot(legacyState, mockEnv);
    const statusReq = new Request("http://bot/status", { method: "GET" });
    const statusRes = await legacyBot.fetch(statusReq);
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json<any>();
    expect(statusBody.symbols).toEqual(["BTC/USDT"]);
    expect(statusBody.coinId).toBe("BTC/USDT");
  });

  // =========================================================================
  // 3. Alarm evaluates every monitored symbol in sequence
  // =========================================================================
  it("Requirement 3: Autonomous alarm evaluates every monitored symbol in sequence", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-p3-3");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 100);
    mockStorage.set("monitoredSymbols", ["SOL/USDT", "ETH/USDT", "BTC/USDT"]);

    await bot.alarm();

    // Verify executeCycle called for each candidate symbol in order
    expect(mockExecuteCycle).toHaveBeenCalledTimes(3);
    expect(mockExecuteCycle).toHaveBeenNthCalledWith(1, "SOL/USDT", "scalper-v2", undefined, 5000);
    expect(mockExecuteCycle).toHaveBeenNthCalledWith(2, "ETH/USDT", "scalper-v2", undefined, 5000);
    expect(mockExecuteCycle).toHaveBeenNthCalledWith(3, "BTC/USDT", "scalper-v2", undefined, 5000);

    // Verify alarm re-scheduled
    expect(mockState.storage.setAlarm).toHaveBeenCalled();
  });

  // =========================================================================
  // 4. One candidate failure does not stop subsequent candidates
  // =========================================================================
  it("Requirement 4: Failure on one candidate is isolated and does not halt evaluation of subsequent candidates", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-p3-4");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 100);
    mockStorage.set("monitoredSymbols", ["FAIL/USDT", "PASS/USDT"]);

    mockExecuteCycle.mockImplementation((symbol: string) => {
      if (symbol === "FAIL/USDT") {
        return Promise.reject(new Error("Network timeout fetching klines for FAIL/USDT"));
      }
      return Promise.resolve([
        {
          strategyId: "scalper-v2",
          confidenceScore: 90,
          hasSignal: true,
          metadata: {
            signal: {
              type: "BUY",
              signalPrice: 100,
              stopLoss: 95,
              takeProfit: 110,
              riskAssessment: { positionSizeRecommendation: 200 },
            },
          },
        },
      ]);
    });

    // alarm() should not throw
    await expect(bot.alarm()).resolves.not.toThrow();

    // Verify both symbols were attempted
    expect(mockExecuteCycle).toHaveBeenCalledTimes(2);
    expect(mockExecuteCycle).toHaveBeenNthCalledWith(1, "FAIL/USDT", "scalper-v2", undefined, 5000);
    expect(mockExecuteCycle).toHaveBeenNthCalledWith(2, "PASS/USDT", "scalper-v2", undefined, 5000);

    // Verify PASS/USDT successfully generated an alert
    const alerts = mockStorage.get("alerts");
    expect(alerts).toBeDefined();
    expect(alerts.length).toBe(1);
    expect(alerts[0].symbol).toBe("PASS/USDT");

    // Alarm re-scheduled
    expect(mockState.storage.setAlarm).toHaveBeenCalled();
  });

  // =========================================================================
  // 5. MarketRegime rejection uses continue and does not stop later candidates
  // =========================================================================
  it("Requirement 5: MarketRegime check failure uses candidate-level continue and evaluates later candidates", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-p3-5");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 100);
    mockStorage.set("monitoredSymbols", ["REGIME_REJECT/USDT", "REGIME_ACCEPT/USDT"]);

    vi.spyOn(MarketRegimeEngine, "isStrategyAllowed").mockImplementation((strat: string, regime: any) => {
      // Reject REGIME_REJECT/USDT, accept REGIME_ACCEPT/USDT
      if (regime.symbol === "REGIME_REJECT/USDT" || regime.dominantDirection === "REJECT") {
        return { allowed: false, reason: "Regime volatile" };
      }
      return { allowed: true, reason: "Regime favorable" };
    });

    vi.spyOn(MarketRegimeEngine, "evaluate").mockImplementation((highs: number[], lows: number[], closes: number[], currentPrice: number) => {
      // Simulate evaluate
      return {
        regime: "SIDEWAYS_HIGH_VOL",
        score: 40,
        dominantDirection: "REJECT",
        symbol: "REGIME_REJECT/USDT",
      } as any;
    });

    let callCount = 0;
    vi.spyOn(MarketRegimeEngine, "isStrategyAllowed").mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { allowed: false, reason: "Market regime not compatible for candidate 1" };
      }
      return { allowed: true, reason: "Compatible" };
    });

    await bot.alarm();

    // Both candidates were processed by executeCycle
    expect(mockExecuteCycle).toHaveBeenCalledTimes(2);

    // Alert was generated ONLY for candidate 2 (REGIME_ACCEPT/USDT)
    const alerts = mockStorage.get("alerts");
    expect(alerts).toBeDefined();
    expect(alerts.length).toBe(1);
    expect(alerts[0].symbol).toBe("REGIME_ACCEPT/USDT");
  });

  // =========================================================================
  // 6. Pending alert deduplication remains symbol-specific
  // =========================================================================
  it("Requirement 6: Pending alert deduplication is symbol-specific and does not block other candidates", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    const existingAlert = {
      id: "existing-sol-alert",
      symbol: "SOL/USDT",
      signalPrice: 100,
      targetEntryPrice: 100,
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      estimatedPnl: 15,
      positionSize: 100,
      strategy: "scalper-v2_NEW",
      side: "BUY" as const,
      timestamp: new Date().toISOString(),
      status: "pending" as const,
    };

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-p3-6");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 100);
    mockStorage.set("monitoredSymbols", ["SOL/USDT", "ETH/USDT"]);
    mockStorage.set("alerts", [existingAlert]);

    await bot.alarm();

    // Verify SOL was deduplicated (no second SOL alert added), but ETH generated a new alert
    const alerts = mockStorage.get("alerts");
    expect(alerts).toBeDefined();
    expect(alerts.length).toBe(2);

    expect(alerts[0].id).toBe("existing-sol-alert");
    expect(alerts[0].symbol).toBe("SOL/USDT");

    expect(alerts[1].symbol).toBe("ETH/USDT");
    expect(alerts[1].status).toBe("pending");
  });

  // =========================================================================
  // 7. Secondary-symbol execution in /execute-trade uses target.symbol over coinId
  // =========================================================================
  it("Requirement 7: /execute-trade dispatches Bybit order using target.symbol, not primary coinId", async () => {
    const { ExchangeManager } = await import("../../src/exchanges");
    const bot = new TradingBot(mockState, mockEnv);

    const ethAlert = {
      id: "alert-eth-777",
      symbol: "ETH/USDT",
      signalPrice: 100,
      targetEntryPrice: 100,
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      estimatedPnl: 10,
      positionSize: 100,
      strategy: "scalper-v2",
      side: "BUY" as const,
      timestamp: new Date().toISOString(),
      status: "pending" as const,
    };

    mockStorage.set("userId", "user-p3-7");
    mockStorage.set("coinId", "BTC/USDT"); // Legacy primary coinId is BTC/USDT
    mockStorage.set("monitoredSymbols", ["BTC/USDT", "SOL/USDT", "ETH/USDT"]);
    mockStorage.set("alerts", [ethAlert]);

    const execReq = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-p3-7", alertId: "alert-eth-777" }),
    });

    const res = await bot.fetch(execReq);
    expect(res.status).toBe(200);

    // Verify Bybit order was dispatched for ETH/USDT, NOT BTC/USDT!
    expect(ExchangeManager.executeIdempotentOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        symbol: "ETH/USDT",
      })
    );
  });

  // =========================================================================
  // 8. Empty activation rejected with HTTP 400, never defaulting to BTCUSDT
  // =========================================================================
  it("Requirement 8: Empty activation requests are rejected with HTTP 400 and NEVER fall back to BTCUSDT", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    // 8a. Empty symbols array
    const req1 = new Request("http://bot/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-p3-8",
        symbols: [],
        strategy: "scalper-v2",
      }),
    });
    const res1 = await bot.fetch(req1);
    expect(res1.status).toBe(400);
    const body1 = await res1.json<any>();
    expect(body1.code).toBe("INVALID_SYMBOLS");
    expect(body1.error).toContain("No valid trading symbols provided");
    expect(mockStorage.get("isActive")).toBeUndefined();
    expect(mockStorage.get("coinId")).toBeUndefined();

    // 8b. Empty symbols array with blank coinId
    const req2 = new Request("http://bot/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-p3-8",
        symbols: [],
        coinId: "   ",
        strategy: "scalper-v2",
      }),
    });
    const res2 = await bot.fetch(req2);
    expect(res2.status).toBe(400);
    const body2 = await res2.json<any>();
    expect(body2.code).toBe("INVALID_SYMBOLS");
    expect(body2.error).toContain("No valid trading symbols provided");

    // 8c. Neither symbols nor coinId provided
    const req3 = new Request("http://bot/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-p3-8",
        strategy: "scalper-v2",
      }),
    });
    const res3 = await bot.fetch(req3);
    expect(res3.status).toBe(400);
    const body3 = await res3.json<any>();
    expect(body3.code).toBe("INVALID_SYMBOLS");
    expect(body3.error).toContain("No valid trading symbols provided");

    // 8d. Symbols array with only whitespace strings
    const req4 = new Request("http://bot/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-p3-8",
        symbols: ["  ", ""],
        strategy: "scalper-v2",
      }),
    });
    const res4 = await bot.fetch(req4);
    expect(res4.status).toBe(400);
    const body4 = await res4.json<any>();
    expect(body4.code).toBe("INVALID_SYMBOLS");
    expect(body4.error).toContain("No valid trading symbols provided");

    // Verify storage was NEVER populated with BTCUSDT or activated
    expect(mockStorage.get("isActive")).toBeUndefined();
    expect(mockStorage.get("coinId")).toBeUndefined();
    expect(mockStorage.get("monitoredSymbols")).toBeUndefined();
  });

  // =========================================================================
  // 9. Deactivation clears monitoredSymbols
  // =========================================================================
  it("Deactivation clears monitoredSymbols, coinId, and cancels alarm", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("monitoredSymbols", ["SOL/USDT", "ETH/USDT"]);
    mockStorage.set("coinId", "SOL/USDT");

    const deactReq = new Request("http://bot/deactivate", { method: "POST" });
    const res = await bot.fetch(deactReq);
    expect(res.status).toBe(200);

    expect(mockStorage.get("isActive")).toBe(false);
    expect(mockStorage.get("monitoredSymbols")).toEqual([]);
    expect(mockStorage.get("coinId")).toBeNull();
  });
});
