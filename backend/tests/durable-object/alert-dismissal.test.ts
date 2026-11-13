import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot, TradeAlert } from "../../src/trading-bot";
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

describe("TradeAlert Dismissal Synchronization & Duplicate Suppression Release", () => {
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
      fetchBalance: vi.fn().mockResolvedValue([
        { asset: 'USDT', free: 10000, total: 10000 }
      ]),
      fetchMarkets: vi.fn().mockResolvedValue([
        {
          id: 'BTCUSDT',
          symbol: 'BTC/USDT',
          quote: 'USDT',
          active: true,
          category: 'linear',
          precision: { amount: 0.001, price: 0.1 },
          limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } }
        }
      ]),
      fetchMarket: vi.fn().mockResolvedValue({
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        quote: 'USDT',
        active: true,
        category: 'linear',
        precision: { amount: 0.001, price: 0.1 },
        limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } }
      }),
      fetchPositions: vi.fn().mockResolvedValue([]),
      createOrder: vi.fn().mockResolvedValue({
        id: 'ord-mock-dismiss',
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
      id: { toString: () => "mock-dismiss-do-id" },
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
        };
      }),
    };

    mockEnv = {
      DB: mockDb,
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      JWT_SECRET: "mock_jwt_secret_which_is_at_least_32_characters_long",
      GLOBAL_TRADING_HALT: "false",
    };
  });

  it("1. Successfully dismisses a pending alert, marks status as 'dismissed', and persists in storage", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "user-dismiss-1");
    mockStorage.set("alerts", [
      {
        id: "alert-dismiss-101",
        symbol: "BTC/USDT",
        strategy: "ScalperV2",
        side: "BUY",
        status: "pending",
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        positionSize: 100,
        quantity: 0.002,
        timestamp: new Date().toISOString(),
      }
    ]);

    const req = new Request("http://bot/dismiss-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "alert-dismiss-101", userId: "user-dismiss-1" }),
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.status).toBe("dismissed");
    expect(body.alertId).toBe("alert-dismiss-101");

    const storedAlerts = mockStorage.get("alerts") as TradeAlert[];
    expect(storedAlerts.length).toBe(1);
    expect(storedAlerts[0].status).toBe("dismissed");
  });

  it("2. Successfully dismisses an acknowledged alert", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "user-dismiss-2");
    mockStorage.set("alerts", [
      {
        id: "alert-ack-102",
        symbol: "BTC/USDT",
        strategy: "ScalperV2",
        side: "BUY",
        status: "acknowledged",
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        positionSize: 100,
        quantity: 0.002,
        timestamp: new Date().toISOString(),
      }
    ]);

    const req = new Request("http://bot/dismiss-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "alert-ack-102" }),
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.status).toBe("dismissed");

    const storedAlerts = mockStorage.get("alerts") as TradeAlert[];
    expect(storedAlerts[0].status).toBe("dismissed");
  });

  it("3. Idempotency: Re-dismissing an already dismissed alert returns HTTP 200 without error", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "user-dismiss-3");
    mockStorage.set("alerts", [
      {
        id: "alert-already-dismissed",
        symbol: "BTC/USDT",
        strategy: "ScalperV2",
        side: "BUY",
        status: "dismissed",
        timestamp: new Date().toISOString(),
      }
    ]);

    const req = new Request("http://bot/dismiss-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "alert-already-dismissed" }),
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.message).toContain("already dismissed");
    expect(body.status).toBe("dismissed");
  });

  it("4. Rejects dismissal with HTTP 409 if alert has entered execution (submitted, executed, filled, partially_filled)", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "user-dismiss-4");

    const executionStatuses: TradeAlert['status'][] = ['submitted', 'partially_filled', 'filled', 'executed'];

    for (const status of executionStatuses) {
      mockStorage.set("alerts", [
        {
          id: `alert-${status}`,
          symbol: "BTC/USDT",
          strategy: "ScalperV2",
          side: "BUY",
          status,
          timestamp: new Date().toISOString(),
        }
      ]);

      const req = new Request("http://bot/dismiss-alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertId: `alert-${status}` }),
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const body = await res.json<any>();
      expect(body.success).toBe(false);
      expect(body.error).toBe("EXECUTION_IN_PROGRESS");
    }
  });

  it("5. Rejects dismissal with HTTP 409 if active WAL intent exists for alert", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "user-dismiss-5");
    mockStorage.set("alerts", [
      {
        id: "alert-with-wal-intent",
        symbol: "BTC/USDT",
        strategy: "ScalperV2",
        side: "BUY",
        status: "pending",
        timestamp: new Date().toISOString(),
      }
    ]);
    mockStorage.set("intent:order:alert-with-wal-intent", {
      status: "DISPATCHING",
      symbol: "BTC/USDT",
      intentId: "intent-123",
    });

    const req = new Request("http://bot/dismiss-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "alert-with-wal-intent" }),
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error).toBe("EXECUTION_IN_PROGRESS");
  });

  it("6. Returns HTTP 400 when alertId is missing, and HTTP 404 when alert does not exist", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "user-dismiss-6");
    mockStorage.set("alerts", []);

    // Missing alertId
    const reqMissing = new Request("http://bot/dismiss-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const resMissing = await bot.fetch(reqMissing);
    expect(resMissing.status).toBe(400);

    // Non-existent alertId
    const reqNotFound = new Request("http://bot/dismiss-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "non-existent-alert-id" }),
    });
    const resNotFound = await bot.fetch(reqNotFound);
    expect(resNotFound.status).toBe(404);
  });

  it("7. Returns HTTP 403 if requested userId does not match DO userId", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "owner-user-id");
    mockStorage.set("alerts", [
      {
        id: "alert-owner-1",
        symbol: "BTC/USDT",
        status: "pending",
        timestamp: new Date().toISOString(),
      }
    ]);

    const reqUnauthorized = new Request("http://bot/dismiss-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "alert-owner-1", userId: "attacker-user-id" }),
    });
    const resUnauthorized = await bot.fetch(reqUnauthorized);
    expect(resUnauthorized.status).toBe(403);
  });

  it("8. Dismissed alert is excluded from /alerts endpoint", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "user-dismiss-8");
    mockStorage.set("alerts", [
      {
        id: "alert-dismissed-ex",
        symbol: "BTC/USDT",
        status: "dismissed",
        timestamp: new Date().toISOString(),
      },
      {
        id: "alert-pending-ex",
        symbol: "ETH/USDT",
        status: "pending",
        timestamp: new Date().toISOString(),
      }
    ]);

    const res = await bot.fetch(new Request("http://bot/alerts", { method: "GET" }));
    expect(res.status).toBe(200);
    const activeAlerts = await res.json<any[]>();
    expect(activeAlerts.length).toBe(1);
    expect(activeAlerts[0].id).toBe("alert-pending-ex");
  });

  it("9. Trade execution endpoint rejects dismissed alert with HTTP 409 ALERT_NOT_EXECUTABLE", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", "user-dismiss-9");
    mockStorage.set("alerts", [
      {
        id: "alert-dismissed-target",
        symbol: "BTC/USDT",
        strategy: "ScalperV2",
        side: "BUY",
        status: "dismissed",
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        positionSize: 100,
        quantity: 0.002,
        timestamp: new Date().toISOString(),
      }
    ]);

    const execReq = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-dismiss-9", alertId: "alert-dismissed-target" }),
    });

    const execRes = await bot.fetch(execReq);
    expect(execRes.status).toBe(409);
    const body = await execRes.json<any>();
    expect(body.success).toBe(false);
    expect(body.code).toBe("ALERT_NOT_EXECUTABLE");
  });

  it("10. Duplicate Suppression Lifecycle: Pending alert suppresses new candidate; Dismissal immediately releases symbol for new alert without 300s wait", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-lifecycle-test");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 100);
    mockStorage.set("monitoredSymbols", ["BTC/USDT"]);
    mockStorage.set("lock:alarmGeneration", 1);

    mockStorage.set('approvedCandidateRecord', {
      approvalGeneration: 1,
      userId: 'user-lifecycle-test',
      budgetUsdt: 100,
      approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
      approvalState: 'FINAL_APPROVED',
      exchangeName: 'bybit',
      environment: 'testnet',
      accountFingerprint: 'bybit:testnet',
      orderType: 'ALL',
      approvedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      symbolMetadataSnapshot: {}
    });

    // Initial alert on BTC/USDT (<5m old, pending)
    mockStorage.set("alerts", [
      {
        id: "alert-initial-btc",
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

    // Cycle 1: Pending alert MUST suppress new alert
    await bot.alarm();
    let currentAlerts = (mockStorage.get("alerts") as TradeAlert[]) || [];
    expect(currentAlerts.length).toBe(1);
    expect(currentAlerts[0].id).toBe("alert-initial-btc");
    expect(currentAlerts[0].status).toBe("pending");

    // Action: User dismisses alert-initial-btc
    const dismissReq = new Request("http://bot/dismiss-alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId: "alert-initial-btc", userId: "user-lifecycle-test" }),
    });
    const dismissRes = await bot.fetch(dismissReq);
    expect(dismissRes.status).toBe(200);

    const dismissedAlerts = (mockStorage.get("alerts") as TradeAlert[]) || [];
    expect(dismissedAlerts.length).toBe(1);
    expect(dismissedAlerts[0].status).toBe("dismissed");

    // Cycle 2: Immediately run alarm again with candidate signal for BTC/USDT
    // The duplicate suppression gate MUST be released immediately!
    await bot.alarm();

    const afterDismissAlerts = (mockStorage.get("alerts") as TradeAlert[]) || [];
    // Should now contain 2 alerts: the dismissed historical alert AND the newly generated alert!
    expect(afterDismissAlerts.length).toBe(2);
    const newAlert = afterDismissAlerts.find(a => a.id !== "alert-initial-btc");
    expect(newAlert).toBeDefined();
    expect(newAlert?.symbol).toBe("BTC/USDT");
    expect(newAlert?.status).toBe("pending");
    expect(newAlert?.strategy).toBe("momentum_NEW");
  });
});
