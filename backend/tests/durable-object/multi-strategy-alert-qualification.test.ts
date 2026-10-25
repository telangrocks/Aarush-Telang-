import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot } from "../../src/trading-bot";

// Mock security crypto
vi.mock("../../src/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key"),
  encrypt: vi.fn().mockResolvedValue({ iv: "mock_iv", encrypted: "mock_enc", salt: "mock_salt" })
}));

// Mock exchanges adapter
vi.mock("../../src/exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: vi.fn().mockImplementation((sym: string) => {
          return Promise.resolve({ symbol: sym.replace('/', ''), last: 50000, bid: 49990, ask: 50010, high: 51000, low: 49000, volume: 100, quoteVolume: 5000000 });
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
        fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 10000 }, total: { USDT: 10000 } }),
        fetchMarkets: vi.fn().mockResolvedValue([
          { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 1.0 }, limits: { cost: { min: 5 }, amount: { min: 0.001 } } },
          { id: 'ETHUSDT', symbol: 'ETH/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.01 } } },
          { id: 'XRPUSDT', symbol: 'XRP/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 1.0, price: 0.0001 }, limits: { cost: { min: 5 }, amount: { min: 1.0 } } },
        ]),
        fetchMarket: vi.fn().mockImplementation(async (sym: string) => {
          const list = [
            { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 1.0 }, limits: { cost: { min: 5 }, amount: { min: 0.001 } } },
            { id: 'ETHUSDT', symbol: 'ETH/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.01 } } },
            { id: 'XRPUSDT', symbol: 'XRP/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 1.0, price: 0.0001 }, limits: { cost: { min: 5 }, amount: { min: 1.0 } } },
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

describe("Multi-Strategy Alert Qualification & Schema-Safe Lifecycle Expiry Regression", () => {
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
              exchange_name: 'bybit',
              exchange_environment: 'testnet',
              exchange_region: 'global',
              exchange_api_key_iv: 'iv',
              exchange_api_key_encrypted: 'enc',
              exchange_api_key_salt: 'salt',
              exchange_api_secret_encrypted: 'mock_secret',
              exchange_api_secret_iv: 'mock_iv',
            })
          }),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({ success: true }),
          first: vi.fn().mockResolvedValue(null)
        };
      })
    };

    mockEnv = {
      DB: mockDb,
      ENCRYPTION_KEY: "mock_key_0123456789012345678901",
      FCM_SERVER_KEY: "mock_fcm_key",
      ENVIRONMENT: "test",
      GLOBAL_TRADING_HALT: "false"
    };
  });

  // --------------------------------------------------------------------------
  // 1. Single Active Alert per Normalized Ticker Gate
  // --------------------------------------------------------------------------
  it("enforces single active alert per normalized ticker: first qualifying strategy alerts and suppresses subsequent same-ticker candidates", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    // Set committed strategy in DO to 'scalper-v2'
    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-multi-strat");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 100);
    mockStorage.set("monitoredSymbols", ["BTC/USDT"]);
    mockStorage.set("lock:alarmGeneration", 1);

    // Return 3 qualifying strategies in the same cycle for BTC/USDT: scalper-v2, momentum, and breakout
    mockExecuteCycle.mockResolvedValue([
      {
        strategyId: 'scalper-v2',
        confidenceScore: 85,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            stopLoss: 49000,
            takeProfit: 52000,
            timeframe: '5m',
            riskAssessment: { positionSizeRecommendation: 100 }
          }
        }
      },
      {
        strategyId: 'momentum',
        confidenceScore: 92,
        hasSignal: true,
        metadata: {
          targetTimeframe: '15m',
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            stopLoss: 48500,
            takeProfit: 53000,
            timeframe: '15m',
            riskAssessment: { positionSizeRecommendation: 100 }
          }
        }
      },
      {
        strategyId: 'breakout',
        confidenceScore: 78,
        hasSignal: true,
        metadata: {
          targetTimeframe: '1h',
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            stopLoss: 49200,
            takeProfit: 51500,
            timeframe: '1h',
            riskAssessment: { positionSizeRecommendation: 100 }
          }
        }
      }
    ]);

    await bot.alarm();

    const alerts = mockStorage.get("alerts") || [];

    // Under single active alert per ticker invariant, only 1 alert is created for BTC/USDT;
    // subsequent candidates are suppressed by the SAME_TIMEFRAME_ACTIVE_ALERT gate
    expect(alerts.length).toBe(1);
    const scalperAlert = alerts.find((a: any) => a.strategy === 'scalper-v2_NEW');
    expect(scalperAlert).toBeDefined();
    expect(scalperAlert.symbol).toBe("BTC/USDT");
    expect(scalperAlert.status).toBe("pending");
  });

  it("allows multiple qualifying strategies to independently generate alerts for distinct symbols without committed-strategy suppression", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    // Set committed strategy in DO to 'scalper-v2'
    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-multi-strat");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 100);
    mockStorage.set("monitoredSymbols", ["BTC/USDT", "ETH/USDT", "XRP/USDT"]);
    mockStorage.set("lock:alarmGeneration", 1);

    mockExecuteCycle.mockImplementation((symbol: string) => {
      if (symbol === "BTC/USDT") {
        return Promise.resolve([
          {
            strategyId: 'scalper-v2',
            confidenceScore: 85,
            hasSignal: true,
            metadata: {
              targetTimeframe: '5m',
              signal: {
                type: 'BUY',
                signalPrice: 50000,
                stopLoss: 49000,
                takeProfit: 52000,
                timeframe: '5m',
                riskAssessment: { positionSizeRecommendation: 100 }
              }
            }
          }
        ]);
      } else if (symbol === "ETH/USDT") {
        return Promise.resolve([
          {
            strategyId: 'momentum',
            confidenceScore: 92,
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
      } else if (symbol === "XRP/USDT") {
        return Promise.resolve([
          {
            strategyId: 'breakout',
            confidenceScore: 78,
            hasSignal: true,
            metadata: {
              targetTimeframe: '1h',
              signal: {
                type: 'BUY',
                signalPrice: 1.0,
                stopLoss: 0.95,
                takeProfit: 1.10,
                timeframe: '1h',
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

    // All three distinct symbols independently generate alerts
    expect(alerts.length).toBe(3);
    const scalperAlert = alerts.find((a: any) => a.strategy === 'scalper-v2_NEW' && a.symbol === 'BTC/USDT');
    const momentumAlert = alerts.find((a: any) => a.strategy === 'momentum_NEW' && a.symbol === 'ETH/USDT');
    const breakoutAlert = alerts.find((a: any) => a.strategy === 'breakout_NEW' && a.symbol === 'XRP/USDT');

    expect(scalperAlert).toBeDefined();
    expect(momentumAlert).toBeDefined();
    expect(breakoutAlert).toBeDefined();

    expect(scalperAlert.status).toBe('pending');
    expect(momentumAlert.status).toBe('pending');
    expect(breakoutAlert.status).toBe('pending');
  });

  // --------------------------------------------------------------------------
  // 2. Non-Qualifying Signals
  // --------------------------------------------------------------------------
  it("produces zero alerts for non-qualifying signals (hasSignal: false or missing metadata)", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-no-signal");
    mockStorage.set("strategy", "scalper-v2");
    mockStorage.set("positionSize", 100);
    mockStorage.set("monitoredSymbols", ["BTC/USDT"]);
    mockStorage.set("lock:alarmGeneration", 1);

    mockExecuteCycle.mockResolvedValue([
      {
        strategyId: 'scalper-v2',
        confidenceScore: 40,
        hasSignal: false,
        metadata: { reasoning: ['Score below threshold'] }
      },
      {
        strategyId: 'momentum',
        confidenceScore: 35,
        hasSignal: false,
        metadata: null
      }
    ]);

    await bot.alarm();

    const alerts = mockStorage.get("alerts") || [];
    expect(alerts.length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 3. Prior-Generation Autonomous Alerts Expired on Activate and Deactivate
  // --------------------------------------------------------------------------
  it("expires prior-generation autonomous alerts on /activate while preserving new alarm generation", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    // Initial state: generation 1 with an autonomous alert from generation 1
    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-lifecycle");
    mockStorage.set("lock:alarmGeneration", 1);
    mockStorage.set("alerts", [
      {
        id: "auto-gen-1",
        symbol: "BTC/USDT",
        strategy: "ScalperV2_NEW",
        source: "AUTONOMOUS",
        status: "pending",
        generation: 1,
        timestamp: new Date().toISOString()
      },
      {
        id: "auto-no-gen",
        symbol: "ETH/USDT",
        strategy: "Momentum_NEW",
        source: "AUTONOMOUS",
        status: "pending",
        timestamp: new Date().toISOString()
      }
    ]);

    // Activate the bot (transitioning to generation 2)
    const req = new Request("http://internal/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        strategy: "scalper-v2",
        coinId: "BTC/USDT",
        userId: "user-lifecycle"
      })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const updatedGen = mockStorage.get("lock:alarmGeneration");
    expect(updatedGen).toBe(2);

    const alerts = mockStorage.get("alerts") || [];
    const autoGen1 = alerts.find((a: any) => a.id === "auto-gen-1");
    const autoNoGen = alerts.find((a: any) => a.id === "auto-no-gen");

    expect(autoGen1.status).toBe("expired");
    expect(autoNoGen.status).toBe("expired");
  });

  it("expires prior-generation autonomous alerts on /deactivate", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set("isActive", true);
    mockStorage.set("userId", "user-lifecycle");
    mockStorage.set("lock:alarmGeneration", 2);
    mockStorage.set("alerts", [
      {
        id: "auto-gen-2",
        symbol: "BTC/USDT",
        strategy: "ScalperV2_NEW",
        source: "AUTONOMOUS",
        status: "pending",
        generation: 2,
        timestamp: new Date().toISOString()
      }
    ]);

    const req = new Request("http://internal/deactivate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-lifecycle" })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const updatedGen = mockStorage.get("lock:alarmGeneration");
    expect(updatedGen).toBe(3);

    const alerts = mockStorage.get("alerts") || [];
    const autoGen2 = alerts.find((a: any) => a.id === "auto-gen-2");
    expect(autoGen2.status).toBe("expired");
  });

  // --------------------------------------------------------------------------
  // 4. Fresh vs. Stale Manual/Legacy Alerts
  // --------------------------------------------------------------------------
  it("preserves fresh manual alerts (<5m old) on lifecycle transitions", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    mockStorage.set("lock:alarmGeneration", 1);
    mockStorage.set("alerts", [
      {
        id: "fresh-manual-1",
        symbol: "BTC/USDT",
        strategy: "ScalperV2",
        source: "MANUAL",
        status: "pending",
        timestamp: twoMinutesAgo
      }
    ]);

    const req = new Request("http://internal/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        strategy: "scalper-v2",
        coinId: "BTC/USDT",
        userId: "user-lifecycle"
      })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const alerts = mockStorage.get("alerts") || [];
    const freshManual = alerts.find((a: any) => a.id === "fresh-manual-1");
    // Fresh manual alert must NOT be expired
    expect(freshManual.status).toBe("pending");
  });

  it("expires stale manual and legacy orphan alerts (>5m old or missing timestamp) on lifecycle transitions", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    mockStorage.set("lock:alarmGeneration", 1);
    mockStorage.set("alerts", [
      {
        id: "stale-manual-1",
        symbol: "BTC/USDT",
        strategy: "ScalperV2",
        source: "MANUAL",
        status: "pending",
        timestamp: tenMinutesAgo
      },
      // Stale legacy orphan alert exactly like 7e130774-0234-44eb-a313-798e2e17c652 from CID
      {
        id: "7e130774-0234-44eb-a313-798e2e17c652",
        symbol: "XRP/USDT",
        strategy: "ScalperV2",
        status: "pending",
        timestamp: oneDayAgo
      },
      {
        id: "corrupt-ts-alert",
        symbol: "SOL/USDT",
        strategy: "ScalperV2",
        status: "pending",
        timestamp: "invalid-date"
      }
    ]);

    const req = new Request("http://internal/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        strategy: "scalper-v2",
        coinId: "BTC/USDT",
        userId: "user-lifecycle"
      })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const alerts = mockStorage.get("alerts") || [];
    const staleManual = alerts.find((a: any) => a.id === "stale-manual-1");
    const staleOrphan = alerts.find((a: any) => a.id === "7e130774-0234-44eb-a313-798e2e17c652");
    const corruptTs = alerts.find((a: any) => a.id === "corrupt-ts-alert");

    expect(staleManual.status).toBe("expired");
    expect(staleOrphan.status).toBe("expired");
    expect(corruptTs.status).toBe("expired");
  });

  // --------------------------------------------------------------------------
  // 5. In-Flight Orders and Unresolved Reconciliation State Protected
  // --------------------------------------------------------------------------
  it("never expires alerts associated with unresolved in-flight execution or reconciliation intents", async () => {
    const bot = new TradingBot(mockState, mockEnv);

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // In-flight intent exists in storage
    mockStorage.set("intent:order:alert-in-flight-1", {
      intentId: "alert-in-flight-1",
      symbol: "BTC/USDT",
      status: "DISPATCHED",
      createdAt: Date.now() - 3600000
    });

    mockStorage.set("intent:order:alert-reconcile-pending", {
      intentId: "alert-reconcile-pending",
      symbol: "ETH/USDT",
      status: "RECONCILIATION_PENDING",
      createdAt: Date.now() - 3600000
    });

    mockStorage.set("lock:alarmGeneration", 1);
    mockStorage.set("alerts", [
      {
        id: "alert-in-flight-1",
        symbol: "BTC/USDT",
        strategy: "ScalperV2_NEW",
        source: "AUTONOMOUS",
        generation: 1,
        status: "pending",
        timestamp: oneHourAgo
      },
      {
        id: "alert-reconcile-pending",
        symbol: "ETH/USDT",
        strategy: "Momentum_NEW",
        source: "AUTONOMOUS",
        generation: 1,
        status: "acknowledged",
        timestamp: oneHourAgo
      },
      {
        id: "alert-already-filled",
        symbol: "BTC/USDT",
        strategy: "ScalperV2",
        status: "filled",
        timestamp: oneHourAgo
      },
      {
        id: "alert-already-submitted",
        symbol: "BTC/USDT",
        strategy: "ScalperV2",
        status: "submitted",
        timestamp: oneHourAgo
      }
    ]);

    const req = new Request("http://internal/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        strategy: "scalper-v2",
        coinId: "BTC/USDT",
        userId: "user-lifecycle"
      })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const alerts = mockStorage.get("alerts") || [];
    const inFlight = alerts.find((a: any) => a.id === "alert-in-flight-1");
    const reconcilePending = alerts.find((a: any) => a.id === "alert-reconcile-pending");
    const alreadyFilled = alerts.find((a: any) => a.id === "alert-already-filled");
    const alreadySubmitted = alerts.find((a: any) => a.id === "alert-already-submitted");

    // All in-flight, unresolved, and terminal execution alerts must remain untouched!
    expect(inFlight.status).toBe("pending");
    expect(reconcilePending.status).toBe("acknowledged");
    expect(alreadyFilled.status).toBe("filled");
    expect(alreadySubmitted.status).toBe("submitted");
  });
});
