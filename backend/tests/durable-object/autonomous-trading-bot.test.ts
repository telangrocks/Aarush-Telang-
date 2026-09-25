import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot } from "../../src/trading-bot";

const { mockBybitOrder, mockExecuteCycle, getMockCurrentPrice, setMockCurrentPrice } = vi.hoisted(() => {
  let currentPrice = 150.0;
  return {
    mockBybitOrder: vi.fn().mockResolvedValue({
      id: "ord-bybit-777",
      status: "closed",
      filled: { toNumber: () => 1.5 },
      amount: { toNumber: () => 1.5 },
      average: { toNumber: () => 150.0 },
    }),
    mockExecuteCycle: vi.fn(),
    getMockCurrentPrice: () => currentPrice,
    setMockCurrentPrice: (p: number) => { currentPrice = p; },
  };
});

// Mock crypto decryption
vi.mock("../../src/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key"),
}));

// Mock notifications
vi.mock("../../src/handlers/notifications", () => ({
  sendTradeNotification: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../../src/exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: vi.fn().mockImplementation((sym: string) =>
          Promise.resolve({
            symbol: sym.replace('/', ''),
            last: getMockCurrentPrice(),
            bid: 149.9,
            ask: 150.1,
            high: 155.0,
            low: 145.0,
            volume: 1000,
            quoteVolume: 150000,
          })
        ),
        fetchKlines: vi.fn().mockResolvedValue(
          Array.from({ length: 30 }, (_, i) => ({
            openTime: Date.now() - (30 - i) * 3600000,
            open: 140 + i,
            high: 142 + i,
            low: 139 + i,
            close: 141 + i,
            volume: 500,
          }))
        ),
        fetchBalance: vi.fn().mockResolvedValue({
          free: { USDT: 5000 },
          total: { USDT: 5000 },
        }),
        fetchMarkets: vi.fn().mockResolvedValue([
          { id: 'SOLUSDT', symbol: 'SOL/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.01 }, limits: { cost: { min: 5 }, amount: { min: 0.01 } } },
          { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 0.1 }, limits: { cost: { min: 10 }, amount: { min: 0.001 } } },
          { id: 'ETHUSDT', symbol: 'ETH/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.005, price: 0.05 }, limits: { cost: { min: 5 }, amount: { min: 0.005 } } },
        ]),
        fetchPositions: vi.fn().mockResolvedValue([]),
        createOrder: mockBybitOrder,
        executeIdempotentOrder: mockBybitOrder,
        supportsOco: vi.fn().mockReturnValue(false),
        createOcoOrder: vi.fn(),
      }),
      executeIdempotentOrder: mockBybitOrder,
    },
    normalizeEnvironment: vi.fn().mockReturnValue('mainnet'),
    normalizeRegion: vi.fn().mockReturnValue('global'),
  };
});

// Mock StrategyOrchestrator
vi.mock("../../src/engine/orchestrator/StrategyOrchestrator", () => {
  const StrategyOrchestratorMock = vi.fn();
  StrategyOrchestratorMock.prototype.setMarketDataEngine = vi.fn();
  StrategyOrchestratorMock.prototype.executeCycle = (...args: any[]) => mockExecuteCycle(...args);
  StrategyOrchestratorMock.prototype.getCurrentState = vi.fn().mockReturnValue('ACTIVE');

  return {
    StrategyOrchestrator: StrategyOrchestratorMock,
  };
});

describe("Autonomous Multi-Pair Trading Engine - Step 16 Forensic Verification", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    setMockCurrentPrice(150.0);
    mockStorage = new Map();
    mockState = {
      id: { toString: () => "mock-do-id" },
      storage: {
        get: async (key: string) => mockStorage.get(key),
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
        transaction: async (cb: any) => cb({
          put: async (k: string, v: any) => mockStorage.set(k, v),
        }),
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
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ success: true }),
            all: vi.fn().mockResolvedValue({ results: [] }),
            first: vi.fn().mockImplementation(async () => {
              if (query.includes("COUNT(*)")) {
                return { count: 0 };
              }
              return {
                exchange_name: "bybit",
                exchange_environment: "mainnet",
                exchange_region: "global",
                exchange_api_key: "mock_api_key",
                exchange_api_secret_encrypted: "mock_secret",
                exchange_api_secret_iv: "mock_iv",
              };
            }),
          }),
        };
      }),
    };

    mockEnv = {
      DB: mockDb,
      GLOBAL_TRADING_HALT: "false",
      ENCRYPTION_KEY: "test-encryption-key",
    };

    // Default mock cycle result: strong BUY signal
    mockExecuteCycle.mockResolvedValue([
      {
        strategyId: "Momentum",
        confidenceScore: 88,
        hasSignal: true,
        metadata: {
          signal: {
            type: "BUY",
            signalPrice: 150.0,
            stopLoss: 145.0,
            takeProfit: 160.0,
            riskAssessment: {
              positionSizeRecommendation: 250,
            },
          },
          reasoning: ["Strong momentum breakout confirmed on 15m and 1h"],
        },
      },
    ]);
  });

  // =========================================================================
  // TEST A: Activation Journey Preserved
  // Momentum -> USE THIS STRATEGY -> bot active -> strategy = Momentum
  // =========================================================================
  it("Test A (Activation): User activates bot with Momentum -> strategy saved as authoritative and alarm scheduled", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    const activateReq = new Request("http://bot/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-test-1",
        coinId: "BTC/USDT", // Stored for session continuity
        strategy: "Momentum",
        positionSize: 250,
      }),
    });

    const res = await bot.fetch(activateReq);
    expect(res.status).toBe(200);
    const data = await res.json<any>();
    expect(data.success).toBe(true);

    expect(mockStorage.get("isActive")).toBe(true);
    expect(mockStorage.get("strategy")).toBe("Momentum");
    expect(mockStorage.get("coinId")).toBe("BTC/USDT"); // Preserved for UI compatibility
    expect(mockStorage.get("positionSize")).toBe(250);
    expect(mockState.storage.setAlarm).toHaveBeenCalled();
  });

  // =========================================================================
  // TEST B: Dynamic Candidate Discovery & Alert Generation
  // Stored: coinId = BTC/USDT, Scanner: SOL/USDT -> TradeAlert.symbol = SOL/USDT
  // =========================================================================
  it("Test B (Dynamic Candidate): Discovered SOL/USDT produces TradeAlert.symbol = SOL/USDT, not stored BTC/USDT", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-test-1");
    mockStorage.set("coinId", "BTC/USDT"); // Legacy stored coin
    mockStorage.set("strategy", "Momentum");
    mockStorage.set("positionSize", 200);

    // Mock scanner returning SOL/USDT as top opportunity
    bot.setScanner({
      scan: vi.fn().mockResolvedValue({
        universeSize: 100,
        eligibleCount: 45,
        allQualifiedOpportunities: [
          {
            symbol: "SOL/USDT",
            opportunityScore: 92,
            currentRank: 1,
            dominantDirection: "LONG",
            strategyCompatibility: [
              {
                strategyId: "Momentum",
                isAllowedInRegime: true,
                compatibilityScore: 95,
              },
            ],
          },
        ],
        topOpportunities: [],
      }),
    } as any);

    await bot.alarm();

    const alerts = mockStorage.get("alerts");
    expect(alerts).toBeDefined();
    expect(alerts.length).toBe(1);

    // Critical Invariant: Alert symbol is the dynamically discovered candidate, NOT the stored coinId!
    expect(alerts[0].symbol).toBe("SOL/USDT");
    expect(alerts[0].side).toBe("BUY");
    expect(alerts[0].status).toBe("pending");
    expect(alerts[0].positionSize).toBe(200);
    expect(alerts[0].strategy).toBe("Momentum_NEW");
  });

  // =========================================================================
  // TEST C: Strategy Authority
  // Active strategy: Momentum -> evaluates candidate with Momentum, not another strategy
  // =========================================================================
  it("Test C (Strategy Authority): Scanner filters candidates by active strategy Momentum and executes cycle with Momentum", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-test-1");
    mockStorage.set("strategy", "Momentum");

    bot.setScanner({
      scan: vi.fn().mockResolvedValue({
        universeSize: 50,
        eligibleCount: 20,
        allQualifiedOpportunities: [
          {
            symbol: "DOGE/USDT",
            opportunityScore: 90,
            currentRank: 1,
            dominantDirection: "LONG",
            // Not compatible with Momentum, only MeanReversion
            strategyCompatibility: [
              { strategyId: "MeanReversion", isAllowedInRegime: true, compatibilityScore: 90 },
            ],
          },
          {
            symbol: "ETH/USDT",
            opportunityScore: 85,
            currentRank: 2,
            dominantDirection: "LONG",
            // Compatible with Momentum
            strategyCompatibility: [
              { strategyId: "Momentum", isAllowedInRegime: true, compatibilityScore: 88 },
            ],
          },
        ],
        topOpportunities: [],
      }),
    } as any);

    await bot.alarm();

    // Orchestrator must be invoked for ETH/USDT with Momentum, NOT DOGE/USDT
    expect(mockExecuteCycle).toHaveBeenCalledWith(
      "ETH/USDT",
      "Momentum",
      undefined,
      expect.any(Number)
    );

    const alerts = mockStorage.get("alerts");
    expect(alerts).toBeDefined();
    expect(alerts[0].symbol).toBe("ETH/USDT");
    expect(alerts[0].strategy).toBe("Momentum_NEW");
  });

  // =========================================================================
  // TEST D: Symbol Regression in /execute-trade
  // coinId = BTC/USDT, target.symbol = SOL/USDT -> Bybit receives SOLUSDT (SOL/USDT)
  // =========================================================================
  it("Test D (Symbol Regression): target.symbol overrides coinId in /execute-trade so Bybit receives SOL/USDT", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("userId", "user-test-1");
    mockStorage.set("coinId", "BTC/USDT"); // Stored coin MUST NOT override
    mockStorage.set("strategy", "Momentum");
    mockStorage.set("alerts", [
      {
        id: "alert-sol-1",
        symbol: "SOL/USDT",
        signalPrice: 150.0,
        targetEntryPrice: 150.0,
        entryPrice: 150.0,
        stopLoss: 145.0,
        takeProfit: 160.0,
        estimatedPnl: 15,
        positionSize: 200,
        strategy: "Momentum",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
      },
    ]);

    const execReq = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-test-1",
        alertId: "alert-sol-1",
      }),
    });

    const res = await bot.fetch(execReq);
    expect(res.status).toBe(200);

    // Verify Bybit order execution was dispatched for SOL/USDT, NOT BTC/USDT!
    expect(mockBybitOrder).toHaveBeenCalled();
    const orderPayload = mockBybitOrder.mock.calls[0][1];
    expect(orderPayload.symbol).toBe("SOL/USDT");
  });

  // =========================================================================
  // TEST E: Dynamic Alert Deduplication
  // Existing pending SOL alert -> Scanner returns SOL again -> No duplicate alert
  // =========================================================================
  it("Test E (Duplicate Alert): Pending alert for SOL/USDT suppresses duplicate alert creation", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-test-1");
    mockStorage.set("strategy", "Momentum");
    mockStorage.set("alerts", [
      {
        id: "existing-alert-sol",
        symbol: "SOL/USDT",
        signalPrice: 150.0,
        targetEntryPrice: 150.0,
        entryPrice: 150.0,
        stopLoss: 145.0,
        takeProfit: 160.0,
        estimatedPnl: 15,
        positionSize: 200,
        strategy: "Momentum_NEW",
        side: "BUY",
        timestamp: new Date().toISOString(),
        status: "pending",
      },
    ]);

    bot.setScanner({
      scan: vi.fn().mockResolvedValue({
        universeSize: 50,
        eligibleCount: 20,
        allQualifiedOpportunities: [
          {
            symbol: "SOL/USDT",
            opportunityScore: 95,
            currentRank: 1,
            dominantDirection: "LONG",
            strategyCompatibility: [
              { strategyId: "Momentum", isAllowedInRegime: true, compatibilityScore: 95 },
            ],
          },
        ],
        topOpportunities: [],
      }),
    } as any);

    await bot.alarm();

    const alerts = mockStorage.get("alerts");
    expect(alerts.length).toBe(1);
    expect(alerts[0].id).toBe("existing-alert-sol");
  });

  // =========================================================================
  // TEST F: Existing Position Safety
  // Open SOL position -> Scanner returns SOL -> New entry rejected/skipped
  // =========================================================================
  it("Test F (Existing Position Safety): Open SOL/USDT position skips new entry alert", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-test-1");
    mockStorage.set("strategy", "Momentum");
    mockStorage.set("activePositions", [
      {
        id: "pos-sol-open",
        symbol: "SOL/USDT",
        status: "OPEN",
        side: "BUY",
        size: 2,
      },
    ]);

    bot.setScanner({
      scan: vi.fn().mockResolvedValue({
        universeSize: 50,
        eligibleCount: 20,
        allQualifiedOpportunities: [
          {
            symbol: "SOL/USDT",
            opportunityScore: 95,
            currentRank: 1,
            dominantDirection: "LONG",
            strategyCompatibility: [
              { strategyId: "Momentum", isAllowedInRegime: true, compatibilityScore: 95 },
            ],
          },
        ],
        topOpportunities: [],
      }),
    } as any);

    await bot.alarm();

    const alerts = mockStorage.get("alerts");
    expect(alerts).toBeUndefined(); // No alert created
  });

  // =========================================================================
  // TEST G: Scanner Failure Must Be Safe
  // Scanner fails / throws -> no TradeAlert, no order, no fallback to stored coin
  // =========================================================================
  it("Test G (Scanner Failure): Scanner error skips cycle cleanly with NO trade and NO fallback to stored coin", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-test-1");
    mockStorage.set("coinId", "BTC/USDT"); // Legacy stored coin
    mockStorage.set("strategy", "Momentum");

    // Scanner throws an error (e.g. network timeout)
    bot.setScanner({
      scan: vi.fn().mockRejectedValue(new Error("Exchange network timeout")),
    } as any);

    await bot.alarm();

    // Invariant: No TradeAlert was created, no fallback to BTC/USDT occurred
    const alerts = mockStorage.get("alerts");
    expect(alerts).toBeUndefined();
    expect(mockExecuteCycle).not.toHaveBeenCalled();
    expect(mockBybitOrder).not.toHaveBeenCalled();
    expect(mockState.storage.setAlarm).toHaveBeenCalled(); // Alarm continues safely
  });

  // =========================================================================
  // TEST H: Real Execution Pipeline
  // Dynamic candidate -> TradeAlert -> /execute-trade -> ExchangeManager -> Bybit
  // =========================================================================
  it("Test H (Real Execution): Full autonomous candidate pipeline executes real Bybit order with exact parameters", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("userId", "user-test-1");
    mockStorage.set("coinId", "BTC/USDT");
    mockStorage.set("strategy", "Momentum");

    const dynamicAlert = {
      id: "alert-sol-auto-1",
      symbol: "SOL/USDT",
      signalPrice: 152.5,
      targetEntryPrice: 152.0,
      entryPrice: 152.5,
      stopLoss: 147.0,
      takeProfit: 165.0,
      estimatedPnl: 13.0,
      positionSize: 300,
      strategy: "Momentum",
      side: "BUY" as const,
      timestamp: new Date().toISOString(),
      status: "pending" as const,
    };

    mockStorage.set("alerts", [dynamicAlert]);

    const execReq = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-test-1",
        alertId: "alert-sol-auto-1",
      }),
    });

    const res = await bot.fetch(execReq);
    expect(res.status).toBe(200);

    expect(mockBybitOrder).toHaveBeenCalled();
    const orderPayload = mockBybitOrder.mock.calls[0][1];

    // Authoritative execution checks
    expect(orderPayload.symbol).toBe("SOL/USDT");
    expect(orderPayload.side.toUpperCase()).toBe("BUY");
    expect(orderPayload.type.toUpperCase()).toBe("LIMIT"); // targetEntryPrice specified
    expect(Number(orderPayload.price)).toBe(152.0);
    expect(orderPayload.stopLoss).toBe(147.0);
    expect(orderPayload.takeProfit).toBe(165.0);
  });

  it("TEST A — User allocation: User enters 5 USDT -> represents capital allocation, NOT coin entry price", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const req = new Request("http://bot/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-alloc-1",
        coinId: "BTC/USDT",
        strategy: "Momentum",
        positionSize: 5.0, // 5 USDT capital per trade
      }),
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    expect(mockStorage.get("positionSize")).toBe(5.0);
    expect(mockStorage.get("targetEntryPrice")).toBeUndefined();
  });

  it("TEST B — Dynamic candidate: Quantity calculated from 5 USDT / live price under Bybit rules", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    setMockCurrentPrice(100.0);
    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-test-1");
    mockStorage.set("positionSize", 5.0); // 5 USDT allocation
    mockStorage.set("strategy", "Momentum");

    bot.setScanner({
      scan: vi.fn().mockResolvedValue({
        universeSize: 25,
        eligibleCount: 15,
        allQualifiedOpportunities: [
          {
            symbol: "SOL/USDT",
            opportunityScore: 92,
            currentRank: 1,
            dominantDirection: "LONG",
            strategyCompatibility: [
              { strategyId: "Momentum", isAllowedInRegime: true, compatibilityScore: 90 },
            ],
          },
        ],
        topOpportunities: [],
      }),
    } as any);

    mockExecuteCycle.mockResolvedValueOnce([
      {
        strategyId: "momentum",
        timestamp: Date.now(),
        confidenceScore: 88,
        hasSignal: true,
        metadata: {
          signal: {
            type: "BUY",
            signalPrice: 100.0,
            stopLoss: 95.0,
            takeProfit: 110.0,
            riskAssessment: {
              positionSizeRecommendation: 5.0,
            },
          },
        },
      },
    ]);

    await bot.alarm();

    const alerts = mockStorage.get("alerts");
    expect(alerts).toBeDefined();
    expect(alerts.length).toBe(1);
    const alert = alerts[0];
    expect(alert.symbol).toBe("SOL/USDT");
    expect(alert.positionSize).toBe(5.0);
    expect(alert.entryIntent).toBe("IMMEDIATE");
    expect(alert.targetEntryPrice).toBeUndefined();

    // Execute trade
    const execReq = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-test-1",
        alertId: alert.id,
      }),
    });

    const res = await bot.fetch(execReq);
    expect(res.status).toBe(200);

    expect(mockBybitOrder).toHaveBeenCalled();
    const orderPayload = mockBybitOrder.mock.calls[0][1];
    expect(orderPayload.symbol).toBe("SOL/USDT");
    expect(orderPayload.type.toLowerCase()).toBe("market");
    // Quantity: 5 USDT / 100.0 = 0.05 floored to stepSize 0.01 = 0.05
    expect(Number(orderPayload.amount)).toBe(0.05);
  });

  it("TEST C — Preview isolation: Preview price ($1245.46) cannot become autonomous trade fixed entry price", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-test-1");
    mockStorage.set("positionSize", 5.0);
    mockStorage.set("strategy", "Momentum");
    mockStorage.set("coinId", "BTC/USDT");
    mockStorage.set("targetEntryPrice", 1245.46);

    bot.setScanner({
      scan: vi.fn().mockResolvedValue({
        universeSize: 25,
        eligibleCount: 15,
        allQualifiedOpportunities: [
          {
            symbol: "SOL/USDT",
            opportunityScore: 92,
            currentRank: 1,
            dominantDirection: "LONG",
            strategyCompatibility: [
              { strategyId: "Momentum", isAllowedInRegime: true, compatibilityScore: 90 },
            ],
          },
        ],
        topOpportunities: [],
      }),
    } as any);

    mockExecuteCycle.mockResolvedValueOnce([
      {
        strategyId: "momentum",
        timestamp: Date.now(),
        confidenceScore: 85,
        hasSignal: true,
        metadata: {
          signal: {
            type: "BUY",
            signalPrice: 100.0,
            stopLoss: 95.0,
            takeProfit: 110.0,
            riskAssessment: { positionSizeRecommendation: 5.0 },
          },
        },
      },
    ]);

    await bot.alarm();

    const alerts = mockStorage.get("alerts");
    expect(alerts.length).toBe(1);
    const alert = alerts[0];
    expect(alert.symbol).toBe("SOL/USDT");
    expect(alert.targetEntryPrice).toBeUndefined();
    expect(alert.entryPrice).toBe(100.0);
  });

  it("TEST D — Different candidate: Next candidate ETH/USDT uses ETH live price and rules for same 5 USDT allocation", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-test-1");
    mockStorage.set("positionSize", 5.0);
    mockStorage.set("strategy", "Momentum");

    bot.setScanner({
      scan: vi.fn().mockResolvedValue({
        universeSize: 25,
        eligibleCount: 15,
        allQualifiedOpportunities: [
          {
            symbol: "ETH/USDT",
            opportunityScore: 92,
            currentRank: 1,
            dominantDirection: "LONG",
            strategyCompatibility: [
              { strategyId: "Momentum", isAllowedInRegime: true, compatibilityScore: 90 },
            ],
          },
        ],
        topOpportunities: [],
      }),
    } as any);

    mockExecuteCycle.mockResolvedValueOnce([
      {
        strategyId: "momentum",
        timestamp: Date.now(),
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          signal: {
            type: "BUY",
            signalPrice: 100.0, // $100 price allows 5 USDT / 100 = 0.05 ETH to satisfy precision rules
            stopLoss: 95.0,
            takeProfit: 110.0,
            riskAssessment: { positionSizeRecommendation: 5.0 },
          },
        },
      },
    ]);

    await bot.alarm();

    const alerts = mockStorage.get("alerts");
    expect(alerts.length).toBe(1);
    const alert = alerts[0];
    expect(alert.symbol).toBe("ETH/USDT");
    expect(alert.positionSize).toBe(5.0);
    expect(alert.entryPrice).toBe(100.0);
  });

  it("TEST E — Minimum notional: Candidate requiring more than user allocation is rejected without silent capital increase", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-test-1");
    mockStorage.set("positionSize", 5.0); // 5 USDT allocation
    mockStorage.set("strategy", "Momentum");

    // Candidate BTC requires minNotional = 10 USDT in mock markets
    bot.setScanner({
      scan: vi.fn().mockResolvedValue({
        universeSize: 25,
        eligibleCount: 15,
        allQualifiedOpportunities: [
          {
            symbol: "BTC/USDT",
            opportunityScore: 95,
            currentRank: 1,
            dominantDirection: "LONG",
            strategyCompatibility: [
              { strategyId: "Momentum", isAllowedInRegime: true, compatibilityScore: 95 },
            ],
          },
        ],
        topOpportunities: [],
      }),
    } as any);

    mockExecuteCycle.mockResolvedValueOnce([
      {
        strategyId: "momentum",
        timestamp: Date.now(),
        confidenceScore: 95,
        hasSignal: true,
        metadata: {
          signal: {
            type: "BUY",
            signalPrice: 60000.0,
            stopLoss: 59000.0,
            takeProfit: 62000.0,
            riskAssessment: { positionSizeRecommendation: 5.0 },
          },
        },
      },
    ]);

    await bot.alarm();

    // Assert: No TradeAlert created!
    const alerts = mockStorage.get("alerts") || [];
    expect(alerts.length).toBe(0);

    // Assert: No Bybit order submitted!
    expect(mockBybitOrder).not.toHaveBeenCalled();
  });

  it("TEST F — SL/TP: Generated from Risk Management configuration for actual dynamic candidate", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-test-1");
    mockStorage.set("positionSize", 10.0);
    mockStorage.set("strategy", "Momentum");

    bot.setScanner({
      scan: vi.fn().mockResolvedValue({
        universeSize: 25,
        eligibleCount: 15,
        allQualifiedOpportunities: [
          {
            symbol: "SOL/USDT",
            opportunityScore: 92,
            currentRank: 1,
            dominantDirection: "LONG",
            strategyCompatibility: [
              { strategyId: "Momentum", isAllowedInRegime: true, compatibilityScore: 90 },
            ],
          },
        ],
        topOpportunities: [],
      }),
    } as any);

    mockExecuteCycle.mockResolvedValueOnce([
      {
        strategyId: "momentum",
        timestamp: Date.now(),
        confidenceScore: 89,
        hasSignal: true,
        metadata: {
          signal: {
            type: "BUY",
            signalPrice: 150.0,
            stopLoss: 142.5, // 5% risk stop
            takeProfit: 165.0, // 10% target
            riskAssessment: { positionSizeRecommendation: 10.0 },
          },
        },
      },
    ]);

    await bot.alarm();

    const alerts = mockStorage.get("alerts");
    expect(alerts.length).toBe(1);
    const alert = alerts[0];
    expect(alert.symbol).toBe("SOL/USDT");
    expect(alert.stopLoss).toBe(142.5);
    expect(alert.takeProfit).toBe(165.0);

    // Execute trade and verify Bybit order receives exact SL/TP
    const execReq = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-test-1",
        alertId: alert.id,
      }),
    });

    const res = await bot.fetch(execReq);
    expect(res.status).toBe(200);

    expect(mockBybitOrder).toHaveBeenCalled();
    const orderPayload = mockBybitOrder.mock.calls[0][1];
    expect(orderPayload.stopLoss).toBe(142.5);
    expect(orderPayload.takeProfit).toBe(165.0);
  });
});