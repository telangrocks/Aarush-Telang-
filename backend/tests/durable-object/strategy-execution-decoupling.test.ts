import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot } from "../../src/trading-bot";
import { StrategyRegistry } from "../../src/engine/strategies/StrategyRegistry";
import { IStrategy } from "../../src/engine/interfaces/IStrategy";
import { StrategyManifest } from "../../src/engine/strategies/StrategyManifest";
import { MarketDataSlice } from "../../src/engine/interfaces/IMarketDataEngine";

// Hoist mock order creation function
const { mockCreateOrder } = vi.hoisted(() => ({
  mockCreateOrder: vi.fn().mockResolvedValue({
    id: "ord-test-123",
    status: "closed",
    filled: { toNumber: () => 0.02 },
    amount: { toNumber: () => 0.02 },
    average: { toNumber: () => 50100 },
  }),
}));

// Mock security crypto
vi.mock("../../src/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key"),
}));

vi.mock("../../src/exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: vi.fn().mockResolvedValue({
          symbol: "BTCUSDT",
          last: 50100,
          bid: 50090,
          ask: 50110,
          high: 51000,
          low: 49000,
          volume: 100,
          quoteVolume: 5010000,
        }),
        fetchKlines: vi.fn().mockResolvedValue([
          { openTime: Date.now(), open: 50000, high: 51000, low: 49000, close: 50500, volume: 100 },
        ]),
        fetchBalance: vi.fn().mockResolvedValue([]),
        fetchMarkets: vi.fn().mockResolvedValue([
          {
            symbol: "BTC/USDT",
            id: "BTCUSDT",
            precision: { amount: 0.0001, price: 0.01 },
            limits: { cost: { min: 5 }, amount: { min: 0.0001 } },
          },
          {
            symbol: "ETH/USDT",
            id: "ETHUSDT",
            precision: { amount: 0.001, price: 0.01 },
            limits: { cost: { min: 5 }, amount: { min: 0.001 } },
          },
          {
            symbol: "SOL/USDT",
            id: "SOLUSDT",
            precision: { amount: 0.01, price: 0.01 },
            limits: { cost: { min: 5 }, amount: { min: 0.01 } },
          },
        ]),
        createOrder: mockCreateOrder,
        supportsOco: vi.fn().mockReturnValue(false),
        createOcoOrder: vi.fn(),
      }),
      executeIdempotentOrder: mockCreateOrder,
      executeIdempotentOcoOrder: vi.fn(),
    },
    normalizeEnvironment: vi.fn().mockReturnValue("testnet"),
    normalizeRegion: vi.fn().mockReturnValue("global"),
    resolveCanonicalRoutingRegion: vi.fn().mockReturnValue("global"),
  };
});

// Mock the StrategyOrchestrator prototype
vi.mock("../../src/engine/orchestrator/StrategyOrchestrator", () => {
  const StrategyOrchestratorMock = vi.fn();
  StrategyOrchestratorMock.prototype.setMarketDataEngine = vi.fn();
  StrategyOrchestratorMock.prototype.executeCycle = vi.fn().mockResolvedValue([]);
  StrategyOrchestratorMock.prototype.getCurrentState = vi.fn().mockReturnValue("ACTIVE");

  return {
    StrategyOrchestrator: StrategyOrchestratorMock,
  };
});

describe("Decoupled Strategy & Execution Engine - Forensic Verification", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockDb: any;
  let auditLogs: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = new Map();
    auditLogs = [];

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
        transaction: async (cb: any) =>
          cb({
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
        if (query.includes("PRAGMA table_info")) {
          return {
            all: vi.fn().mockResolvedValue({
              results: [{ name: "target_entry_price" }, { name: "entry_status" }],
            }),
          };
        }
        return {
          bind: vi.fn().mockImplementation((...args: any[]) => {
            if (query.includes("INSERT INTO audit_logs")) {
              auditLogs.push({ query, args });
            }
            return {
              run: vi.fn().mockResolvedValue({ success: true }),
              all: vi.fn().mockResolvedValue({ results: [] }),
              first: vi.fn().mockResolvedValue({
                exchange_name: "bybit",
                exchange_environment: "demo",
                exchange_region: "global",
                exchange_api_key: "mock_api_key",
                exchange_api_secret_encrypted: "mock_secret_enc",
                exchange_api_secret_iv: "bW9ja19pdk1vY2tJdk1vY2s=",
                exchange_api_secret_salt: "salt",
              }),
            };
          }),
        };
      }),
    };

    mockEnv = {
      DB: mockDb,
      GLOBAL_TRADING_HALT: "false",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
  });

  // =========================================================================
  // TEST 1: Committed strategy = Breakout, alert strategy = ScalperV2
  // Execution SUCCEEDS (no HTTP 409)
  // =========================================================================
  it("Test 1: Committed strategy = Breakout, alert strategy = ScalperV2 -> execution SUCCEEDS without 409", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("userId", "user-test-1");
    mockStorage.set("isActive", true);
    mockStorage.set("strategy", "Breakout"); // Active bot running Breakout
    mockStorage.set("coinId", "BTC/USDT");

    const alertId = "alert-scalper-001";
    mockStorage.set("alerts", [
      {
        id: alertId,
        symbol: "BTC/USDT",
        signalPrice: 50100,
        targetEntryPrice: 50100,
        entryPrice: 50100,
        stopLoss: 49500,
        takeProfit: 51200,
        positionSize: 100,
        strategy: "ScalperV2", // Manual alert with ScalperV2
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
      },
    ]);

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-test-1", alertId }),
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(mockCreateOrder).toHaveBeenCalled();
  });

  // =========================================================================
  // TEST 2: Committed strategy = ScalperV2, alert strategy = Breakout
  // Execution SUCCEEDS (no HTTP 409)
  // =========================================================================
  it("Test 2: Committed strategy = ScalperV2, alert strategy = Breakout -> execution SUCCEEDS without 409", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("userId", "user-test-2");
    mockStorage.set("isActive", true);
    mockStorage.set("strategy", "ScalperV2"); // Active bot running ScalperV2
    mockStorage.set("coinId", "ETH/USDT");

    const alertId = "alert-breakout-002";
    mockStorage.set("alerts", [
      {
        id: alertId,
        symbol: "ETH/USDT",
        signalPrice: 3000,
        targetEntryPrice: 3000,
        entryPrice: 3000,
        stopLoss: 2900,
        takeProfit: 3200,
        positionSize: 150,
        strategy: "Breakout", // Manual alert with Breakout
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
      },
    ]);

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-test-2", alertId }),
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(mockCreateOrder).toHaveBeenCalled();
  });

  // =========================================================================
  // TEST 3: No committed strategy (bot inactive/deactivated), alert = ScalperV2
  // Execution SUCCEEDS
  // =========================================================================
  it("Test 3: No committed strategy (bot inactive/deactivated), alert = ScalperV2 -> execution SUCCEEDS", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("userId", "user-test-3");
    mockStorage.set("isActive", false);
    mockStorage.delete("strategy"); // No strategy committed
    mockStorage.set("coinId", null);

    const alertId = "alert-manual-003";
    mockStorage.set("alerts", [
      {
        id: alertId,
        symbol: "SOL/USDT",
        signalPrice: 150,
        targetEntryPrice: 150,
        entryPrice: 150,
        stopLoss: 145,
        takeProfit: 160,
        positionSize: 50,
        strategy: "ScalperV2",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
      },
    ]);

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-test-3", alertId }),
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(mockCreateOrder).toHaveBeenCalled();
  });

  // =========================================================================
  // TEST 4: Autonomous trade with matching strategy -> execution SUCCEEDS
  // =========================================================================
  it("Test 4: Autonomous trade with matching strategy -> execution SUCCEEDS as before", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("userId", "user-test-4");
    mockStorage.set("isActive", true);
    mockStorage.set("strategy", "Momentum");
    mockStorage.set("coinId", "BTC/USDT");

    const alertId = "alert-auto-004";
    mockStorage.set("alerts", [
      {
        id: alertId,
        symbol: "BTC/USDT",
        signalPrice: 50100,
        targetEntryPrice: 50100,
        entryPrice: 50100,
        stopLoss: 49000,
        takeProfit: 52000,
        positionSize: 200,
        strategy: "Momentum",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
      },
    ]);

    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-test-4", alertId }),
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(mockCreateOrder).toHaveBeenCalled();
  });

  // =========================================================================
  // TEST 5: Multiple manual trades with different strategies executed consecutively
  // without interference
  // =========================================================================
  it("Test 5: Multiple manual trades with different strategies execute consecutively without interference", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("userId", "user-test-5");
    mockStorage.set("isActive", true);
    mockStorage.set("strategy", "Breakout"); // Active background bot is Breakout

    const alerts = [
      {
        id: "alert-seq-1",
        symbol: "BTC/USDT",
        signalPrice: 50100,
        targetEntryPrice: 50100,
        entryPrice: 50100,
        stopLoss: 49000,
        takeProfit: 52000,
        positionSize: 100,
        strategy: "ScalperV2",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
      },
      {
        id: "alert-seq-2",
        symbol: "ETH/USDT",
        signalPrice: 3000,
        targetEntryPrice: 3000,
        entryPrice: 3000,
        stopLoss: 2900,
        takeProfit: 3200,
        positionSize: 100,
        strategy: "Momentum",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
      },
      {
        id: "alert-seq-3",
        symbol: "SOL/USDT",
        signalPrice: 150,
        targetEntryPrice: 150,
        entryPrice: 150,
        stopLoss: 140,
        takeProfit: 165,
        positionSize: 100,
        strategy: "MeanReversion",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
      },
    ];

    mockStorage.set("alerts", alerts);

    // Execute Alert 1 (ScalperV2)
    const res1 = await bot.fetch(
      new Request("http://bot/execute-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-test-5", alertId: "alert-seq-1" }),
      })
    );
    expect(res1.status).toBe(200);

    // Execute Alert 2 (Momentum)
    const res2 = await bot.fetch(
      new Request("http://bot/execute-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-test-5", alertId: "alert-seq-2" }),
      })
    );
    expect(res2.status).toBe(200);

    // Execute Alert 3 (MeanReversion)
    const res3 = await bot.fetch(
      new Request("http://bot/execute-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-test-5", alertId: "alert-seq-3" }),
      })
    );
    expect(res3.status).toBe(200);

    // Verify all 3 orders were dispatched
    expect(mockCreateOrder).toHaveBeenCalledTimes(3);
  });

  // =========================================================================
  // TEST 6: Legitimate safeguards still reject invalid orders
  // =========================================================================
  it("Test 6a: Tick size misalignment is rejected with HTTP 400", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "user-test-6");

    const invalidTickAlert = {
      id: "alert-invalid-tick",
      symbol: "BTC/USDT",
      signalPrice: 50100.12345, // Violates tickSize 0.01
      targetEntryPrice: 50100.12345,
      entryPrice: 50100.12345,
      stopLoss: 49000.0,
      takeProfit: 52000.0,
      positionSize: 100,
      strategy: "ScalperV2",
      side: "BUY",
      timestamp: new Date().toISOString(),
      status: "pending",
    };

    mockStorage.set("alerts", [invalidTickAlert]);

    const res = await bot.fetch(
      new Request("http://bot/execute-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-test-6", alertId: "alert-invalid-tick" }),
      })
    );

    expect(res.status).toBe(400);
    const data = await res.json<any>();
    expect(data.success).toBe(false);
    expect(data.message).toContain("tick size");
  });

  it("Test 6b: Short-sale execution on a long-only strategy is rejected with HTTP 400", async () => {
    // Register a mock long-only strategy with supportsShort = false
    const longOnlyManifest: StrategyManifest = {
      id: "LongOnlyStrategy",
      name: "Long Only Strategy",
      description: "Test strategy with no short support",
      version: "1.0.0",
      timeframes: ["1m"],
      parameters: {},
      requiredIndicators: [],
      supportsShort: false,
    };

    const mockLongOnlyStrategy: IStrategy = {
      manifest: longOnlyManifest,
      analyze: async () => [],
    };

    try {
      StrategyRegistry.getInstance().registerStrategy("LongOnlyStrategy", mockLongOnlyStrategy);
    } catch (_) {}

    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "user-test-6b");

    const shortAlert = {
      id: "alert-short-rejected",
      symbol: "BTC/USDT",
      signalPrice: 50100,
      targetEntryPrice: 50100,
      entryPrice: 50100,
      stopLoss: 51000,
      takeProfit: 48000,
      positionSize: 100,
      strategy: "LongOnlyStrategy",
      side: "SELL", // Short position
      timestamp: new Date().toISOString(),
      status: "pending",
    };

    mockStorage.set("alerts", [shortAlert]);

    const res = await bot.fetch(
      new Request("http://bot/execute-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-test-6b", alertId: "alert-short-rejected" }),
      })
    );

    expect(res.status).toBe(400);
    const data = await res.json<any>();
    expect(data.error).toContain("does not support short positions");
  });

  it("Test 6c: Stale signal older than 5 minutes is rejected with HTTP 400", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "user-test-6c");

    const staleAlert = {
      id: "alert-stale",
      symbol: "BTC/USDT",
      signalPrice: 50100,
      targetEntryPrice: 50100,
      entryPrice: 50100,
      stopLoss: 49000,
      takeProfit: 52000,
      positionSize: 100,
      strategy: "ScalperV2",
      side: "BUY",
      timestamp: new Date(Date.now() - 360000).toISOString(), // 6 minutes ago
      status: "pending",
    };

    mockStorage.set("alerts", [staleAlert]);

    const res = await bot.fetch(
      new Request("http://bot/execute-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-test-6c", alertId: "alert-stale" }),
      })
    );

    expect(res.status).toBe(400);
    const data = await res.json<any>();
    expect(data.error).toContain("Signal has expired");
  });

  // =========================================================================
  // TEST 7: SL/TP and trade amounts are correctly preserved and passed to exchange adapter
  // =========================================================================
  it("Test 7: SL/TP and trade amounts are correctly preserved and passed to exchange adapter", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "user-test-7");

    const alert = {
      id: "alert-params-test",
      symbol: "BTC/USDT",
      signalPrice: 50100,
      targetEntryPrice: 50100,
      entryPrice: 50100,
      stopLoss: 49000,
      takeProfit: 52000,
      positionSize: 100, // 100 USDT
      strategy: "ScalperV2",
      side: "BUY",
      timestamp: new Date().toISOString(),
      status: "pending",
    };

    mockStorage.set("alerts", [alert]);

    const res = await bot.fetch(
      new Request("http://bot/execute-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-test-7", alertId: "alert-params-test" }),
      })
    );

    expect(res.status).toBe(200);
    expect(mockCreateOrder).toHaveBeenCalled();

    // Verify exchange call payload
    const orderPayload = mockCreateOrder.mock.calls[0][1];
    expect(orderPayload.symbol).toBe("BTC/USDT");
    expect(orderPayload.side).toBe("buy");
    expect(orderPayload.stopLoss).toBe(49000);
    expect(orderPayload.takeProfit).toBe(52000);

    // Verify WAL intent persisted with accurate fields
    const intent = mockStorage.get("intent:order:alert-params-test");
    expect(intent).toBeDefined();
    expect(intent.requestedStopLoss).toBe(49000);
    expect(intent.requestedTakeProfit).toBe(52000);
    expect(intent.payloadSnapshot.stopLoss).toBe(49000);
    expect(intent.payloadSnapshot.takeProfit).toBe(52000);
  });

  // =========================================================================
  // TEST 8: Deactivating bot clears active session strategy, leaves trade logs/audit intact
  // =========================================================================
  it("Test 8: Deactivating bot clears active session strategy, leaves trade logs/audit intact", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    // Step 1: Activate bot with Breakout
    const activateReq = new Request("http://bot/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-test-8",
        coinId: "BTC/USDT",
        strategy: "Breakout",
        positionSize: 50,
        config: { customParam: 123 },
      }),
    });

    const actRes = await bot.fetch(activateReq);
    expect(actRes.status).toBe(200);

    // Verify active status
    const statusReq1 = new Request("http://bot/status", { method: "GET" });
    const statusRes1 = await bot.fetch(statusReq1);
    const status1 = await statusRes1.json<any>();
    expect(status1.isActive).toBe(true);
    expect(status1.strategy).toBe("Breakout");
    expect(status1.coinId).toBe("BTC/USDT");
    expect(mockStorage.get("strategyConfig")).toEqual({ customParam: 123 });

    // Step 2: Deactivate bot
    const deactivateReq = new Request("http://bot/deactivate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const deactRes = await bot.fetch(deactivateReq);
    expect(deactRes.status).toBe(200);

    // Verify deactivated status: strategy & coinId are cleared
    const statusReq2 = new Request("http://bot/status", { method: "GET" });
    const statusRes2 = await bot.fetch(statusReq2);
    const status2 = await statusRes2.json<any>();
    expect(status2.isActive).toBe(false);
    expect(status2.strategy).toBeNull();
    expect(status2.coinId).toBeNull();
    expect(mockStorage.get("strategy")).toBeUndefined();
    expect(mockStorage.get("strategyConfig")).toBeUndefined();

    // Verify audit logs are preserved and include the deactivation record
    const logs = mockStorage.get("logs");
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.some((l: any) => l.message.includes("Bot deactivated by user."))).toBe(true);

    // Verify a trade alert with any strategy can execute cleanly post-deactivation
    const alertId = "alert-post-deactivate";
    mockStorage.set("alerts", [
      {
        id: alertId,
        symbol: "BTC/USDT",
        signalPrice: 50100,
        targetEntryPrice: 50100,
        entryPrice: 50100,
        stopLoss: 49000,
        takeProfit: 52000,
        positionSize: 100,
        strategy: "ScalperV2",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
      },
    ]);

    const execReq = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-test-8", alertId }),
    });

    const execRes = await bot.fetch(execReq);
    expect(execRes.status).toBe(200);
    const execBody = await execRes.json<any>();
    expect(execBody.success).toBe(true);
  });
});
