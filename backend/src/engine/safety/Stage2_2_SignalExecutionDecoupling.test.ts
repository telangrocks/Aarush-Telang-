import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSendTradeNotification, mockCreateOrder, mockStateVars } = vi.hoisted(() => {
  return {
    mockSendTradeNotification: vi.fn().mockResolvedValue({ success: true, outcome: 'SUCCESS' }),
    mockCreateOrder: vi.fn().mockResolvedValue({
      id: 'ord-123',
      status: 'closed',
      filled: { toNumber: () => 0.02 },
      amount: { toNumber: () => 0.02 },
      average: { toNumber: () => 50000 }
    }),
    mockStateVars: {
      mockMarketMetadata: {} as any,
      mockCycleResults: [] as any[]
    }
  };
});

import { TradingBot, TradeAlert } from "../../trading-bot";
import { DirectionalMtfArbitrator } from "../arbitration/DirectionalMtfArbitrator";
import { StrategyRegistry } from "../strategies/StrategyRegistry";

// Mock crypto decryption
vi.mock("../../crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key")
}));

// Mock notifications module
vi.mock("../../handlers/notifications", () => ({
  sendTradeNotification: (...args: any[]) => mockSendTradeNotification(...args),
  sendTradeFillNotification: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../../exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: vi.fn().mockImplementation(async (sym: string) => {
          if (sym.includes('DOGE')) {
            return { symbol: 'DOGEUSDT', last: 0.10, bid: 0.099, ask: 0.101, high: 0.12, low: 0.09, volume: 10000 };
          }
          if (sym.includes('ETH')) {
            return { symbol: 'ETHUSDT', last: 3000, bid: 2999, ask: 3001, high: 3100, low: 2900, volume: 100 };
          }
          return { symbol: 'BTCUSDT', last: 50000, bid: 49990, ask: 50010, high: 51000, low: 49000, volume: 100 };
        }),
        fetchKlines: vi.fn().mockResolvedValue(
          Array.from({ length: 60 }, (_, i) => ({
            openTime: Date.now() - (60 - i) * 60000,
            open: 50000,
            high: 50500,
            low: 49500,
            close: 50100,
            volume: 100
          }))
        ),
        fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 10000 }, total: { USDT: 10000 } }),
        fetchMarkets: vi.fn().mockImplementation(async () => [
          {
            id: 'BTCUSDT',
            symbol: 'BTC/USDT',
            active: true,
            precision: mockStateVars.mockMarketMetadata['BTC/USDT']?.precision ?? { amount: 0.001, price: 1.0 },
            limits: mockStateVars.mockMarketMetadata['BTC/USDT']?.limits ?? { cost: { min: 5.0 }, amount: { min: 0.001, max: 1000 } }
          },
          {
            id: 'DOGEUSDT',
            symbol: 'DOGE/USDT',
            active: true,
            precision: mockStateVars.mockMarketMetadata['DOGE/USDT']?.precision ?? { amount: 1.0, price: 0.0001 },
            limits: mockStateVars.mockMarketMetadata['DOGE/USDT']?.limits ?? { cost: { min: 5.0 }, amount: { min: 10.0, max: 1000000 } }
          }
        ]),
        fetchMarket: vi.fn().mockImplementation(async (sym: string) => {
          const m = mockStateVars.mockMarketMetadata[sym];
          if (m) {
            return {
              id: sym.replace('/', ''),
              symbol: sym,
              active: true,
              category: 'linear',
              precision: m.precision,
              limits: m.limits,
              info: m.info
            };
          }
          if (sym === 'DOGE/USDT') {
            return {
              id: 'DOGEUSDT',
              symbol: 'DOGE/USDT',
              active: true,
              category: 'linear',
              precision: { amount: 1.0, price: 0.0001 },
              limits: { cost: { min: 5.0 }, amount: { min: 10.0, max: 1000000 } }
            };
          }
          return {
            id: 'BTCUSDT',
            symbol: 'BTC/USDT',
            active: true,
            category: 'linear',
            precision: { amount: 0.001, price: 1.0 },
            limits: { cost: { min: 5.0 }, amount: { min: 0.001, max: 1000 } }
          };
        }),
        fetchPositions: vi.fn().mockImplementation(async (cat, sym, zero) => (sym && zero ? [{ symbol: sym, positionIdx: 0, size: { toNumber: () => 0 } }] : [])),
        createOrder: mockCreateOrder,
        supportsOco: vi.fn().mockReturnValue(false),
        createOcoOrder: vi.fn()
      }),
      executeIdempotentOrder: vi.fn().mockImplementation((...args: any[]) => mockCreateOrder(...args)),
    },
    normalizeEnvironment: vi.fn().mockReturnValue('testnet'),
    normalizeRegion: vi.fn().mockReturnValue('global'),
  };
});

// Mock StrategyOrchestrator
vi.mock("../../engine/orchestrator/StrategyOrchestrator", () => {
  const MockOrchestrator = vi.fn();
  MockOrchestrator.prototype.setMarketDataEngine = vi.fn();
  MockOrchestrator.prototype.executeCycle = vi.fn().mockImplementation(async () => mockStateVars.mockCycleResults);
  MockOrchestrator.prototype.getCurrentState = vi.fn().mockReturnValue('ACTIVE');
  return {
    StrategyOrchestrator: MockOrchestrator
  };
});

describe("Stage 2.2 — Backend Signal Qualification / Execution Eligibility Decoupling Suite", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockDb: any;
  let bot: TradingBot;

  beforeEach(async () => {
    mockStorage = new Map();
    mockStateVars.mockMarketMetadata = {};
    mockSendTradeNotification.mockClear();
    mockCreateOrder.mockClear();

    mockStorage.set('isActive', true);
    mockStorage.set('userId', 'user-stage22');
    mockStorage.set('coinId', 'BTC/USDT');
    mockStorage.set('monitoredSymbols', ['BTC/USDT']);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 1);
    mockStorage.set('botConfig', { symbol: 'BTC/USDT', timeframe: '5m', enabled: true });
    mockStorage.set('alerts', []);
    mockStorage.set('tradeSetupConfig', {
      positionSize: 1000,
      maxPortfolioExposure: 10000,
      takeProfit: 52000,
      stopLoss: 49000,
      strategyId: 'ScalperV2'
    });

    mockState = {
      id: { toString: () => "mock-stage-22-do" },
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
          get: async (k: string) => mockStorage.get(k),
          put: async (k: string, v: any) => mockStorage.set(k, v),
          delete: async (k: string) => mockStorage.delete(k),
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
        if (query.includes('table_info')) {
          return {
            all: vi.fn().mockResolvedValue({ results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] })
          };
        }
        return {
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({
              exchange_name: 'bybit',
              exchange_environment: 'testnet',
              exchange_region: 'global',
              exchange_api_key: 'mock_key',
              exchange_api_secret_encrypted: 'mock_secret',
              exchange_api_secret_iv: 'mock_iv',
              fcm_token: 'mock-fcm-token-123'
            }),
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockResolvedValue({ success: true })
          }),
          all: vi.fn().mockResolvedValue({ results: [] }),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true })
        };
      }),
      batch: vi.fn().mockResolvedValue([])
    };

    mockEnv = {
      DB: mockDb,
      GLOBAL_TRADING_HALT: "false",
      ENCRYPTION_KEY: "test-encryption-key",
      FCM_SERVER_KEY: "mock-fcm-server-key"
    };

    mockStorage.set('userId', 'user-stage22');
    mockStorage.set('isActive', true);
    mockStorage.set('lock:alarmGeneration', 1);
    mockStorage.set('approvedCandidateRecord', {
      approvalGeneration: 1,
      userId: 'user-stage22',
      budgetUsdt: 1000,
      approvedSymbols: ['BTCUSDT', 'BTC/USDT', 'DOGEUSDT', 'DOGE/USDT'],
      approvalState: 'FINAL_APPROVED',
      exchangeName: 'bybit',
      environment: 'testnet',
      accountFingerprint: 'bybit:testnet',
      orderType: 'ALL',
      approvedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      symbolMetadataSnapshot: {}
    });

    bot = new TradingBot(mockState, mockEnv);
    (bot as any).runtimeState.isInitialized = true;
    (bot as any).runtimeState.isActive = true;
    (bot as any).runtimeState.userId = 'user-stage22';
    (bot as any).runtimeState.coinId = 'BTC/USDT';
    (bot as any).runtimeState.monitoredSymbols = ['BTC/USDT'];
    (bot as any).runtimeState.strategy = 'ScalperV2';
    (bot as any).runtimeState.alerts = [];
    (bot as any).runtimeState.activePositions = [];
    (bot as any).runtimeState.activeIntents = new Map();
    (bot as any).runtimeState.setupSnapshot = {
      positionSize: 1000,
      maxPortfolioExposure: 10000,
      targetEntryPrice: 50000,
      strategy: 'ScalperV2'
    };

    // Default technically qualified BUY candidate
    mockStateVars.mockCycleResults = [
      {
        strategyId: 'ScalperV2',
        hasSignal: true,
        confidenceScore: 85,
        metadata: {
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            stopLoss: 49500,
            takeProfit: 51000,
            timeframe: '5m',
            riskAssessment: {
              riskClassification: 'LOW',
              positionSizeRecommendation: 1000
            }
          },
          targetTimeframe: '5m',
          reasoning: ['Bullish momentum confirmed']
        }
      }
    ];

    // Mock arbitration to pass
    vi.spyOn(DirectionalMtfArbitrator, 'evaluateCandidate').mockReturnValue({
      passed: true,
      gate: 'PASS',
      reasoning: 'Arbitration passed'
    });
  });

  // --- 1. Zero budget suppresses alert publication ---
  it("TEST 1: Zero budget suppresses alert publication (INSUFFICIENT_BUDGET) and sends no FCM notification", async () => {
    (bot as any).runtimeState.setupSnapshot.positionSize = 0;
    (bot as any).runtimeState.positionSize = 0;
    mockStateVars.mockCycleResults[0].metadata.signal.riskAssessment.positionSizeRecommendation = 0;

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);
    expect(mockSendTradeNotification).not.toHaveBeenCalled();
  });

  // --- 2. Negative, NaN or invalid sizing suppresses alert publication ---
  it("TEST 2: Negative or NaN sizing suppresses alert publication (INSUFFICIENT_BUDGET)", async () => {
    (bot as any).runtimeState.setupSnapshot.positionSize = -50;
    mockStateVars.mockCycleResults[0].metadata.signal.riskAssessment.positionSizeRecommendation = NaN;

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);
    expect(mockSendTradeNotification).not.toHaveBeenCalled();
  });

  // --- 3. Exposure exceeded produces a signal-only alert ---
  it("TEST 3: Portfolio exposure exceeded produces signal-only alert (PORTFOLIO_EXPOSURE_EXCEEDED)", async () => {
    (bot as any).runtimeState.setupSnapshot.positionSize = 200;
    (bot as any).runtimeState.setupSnapshot.maxPortfolioExposure = 1000;
    (bot as any).runtimeState.activePositions = [
      { id: 'pos-1', symbol: 'ETH/USDT', status: 'OPEN', side: 'BUY', entryPrice: 3000, quantity: 0.3 } // 900 USDT exposure
    ]; // Current exposure = 900. Proposed = 200. Total = 1100 > 1000 max.

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(1);
    const alert = storedAlerts[0];
    expect(alert.isExecutable).toBe(false);
    expect(alert.ineligibilityReason).toBe("PORTFOLIO_EXPOSURE_EXCEEDED");
    expect(alert.quantity).toBeUndefined();
    expect(alert.requestedBudget).toBe(200);
  });

  // --- 4. Missing stepSize suppresses alert entirely ---
  it("TEST 4: Missing stepSize suppresses alert entirely (LOT_SIZE_METADATA_UNAVAILABLE)", async () => {
    mockStateVars.mockMarketMetadata['BTC/USDT'] = {
      precision: { amount: undefined, price: 1.0 },
      limits: { cost: { min: 5.0 }, amount: { min: 0.001, max: 1000 } }
    };

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);
    expect(mockSendTradeNotification).not.toHaveBeenCalled();
  });

  // --- 5. Missing minOrderQty suppresses alert without fallback ---
  it("TEST 5: Missing minOrderQty suppresses alert without fallback (LOT_SIZE_METADATA_UNAVAILABLE)", async () => {
    mockStateVars.mockMarketMetadata['BTC/USDT'] = {
      precision: { amount: 0.001, price: 1.0 },
      limits: { cost: { min: 5.0 }, amount: { min: undefined, max: 1000 } }
    };

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);
    expect(mockSendTradeNotification).not.toHaveBeenCalled();
  });

  // --- 6. Invalid maxOrderQty suppresses alert ---
  it("TEST 6: Invalid maxOrderQty suppresses alert (LOT_SIZE_METADATA_UNAVAILABLE)", async () => {
    mockStateVars.mockMarketMetadata['BTC/USDT'] = {
      precision: { amount: 0.001, price: 1.0 },
      limits: { cost: { min: 5.0 }, amount: { min: 0.001, max: -5 } }
    };

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);
    expect(mockSendTradeNotification).not.toHaveBeenCalled();
  });

  // --- 7. Missing tickSize suppresses the alert (Data-Integrity Blocker) ---
  it("TEST 7: Missing tickSize suppresses alert entirely (Data-Integrity Blocker)", async () => {
    mockStateVars.mockMarketMetadata['BTC/USDT'] = {
      precision: { amount: 0.001, price: undefined },
      limits: { cost: { min: 5.0 }, amount: { min: 0.001, max: 1000 } }
    };

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);
    expect(mockSendTradeNotification).not.toHaveBeenCalled();
  });

  // --- 8. Minimum quantity unmet suppresses alert ---
  it("TEST 8: Minimum quantity unmet suppresses alert (MIN_ORDER_QTY_UNMET)", async () => {
    // Budget $10 at BTC $50,000 => rawQty = 0.0002 < minOrderQty 0.001
    (bot as any).runtimeState.setupSnapshot.positionSize = 10;

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);
    expect(mockSendTradeNotification).not.toHaveBeenCalled();
  });

  // --- 9. DOGE fixture produces BELOW_MIN_NOTIONAL and suppresses alert ---
  it("TEST 9: DOGE fixture produces BELOW_MIN_NOTIONAL when minOrderQty is met but notional < 5 USDT", async () => {
    // DOGE at $0.10, stepSize = 1.0, minOrderQty = 10 (notional $1.00), minNotional = 5.0
    // Budget = $3.00 => rawQty = 30 >= 10. PostRoundingNotional = 3.00 < 5.00
    mockStorage.set('botConfig', { symbol: 'DOGE/USDT', timeframe: '5m', enabled: true });
    mockStorage.set('coinId', 'DOGE/USDT');
    mockStorage.set('monitoredSymbols', ['DOGE/USDT']);
    (bot as any).runtimeState.coinId = 'DOGE/USDT';
    (bot as any).runtimeState.monitoredSymbols = ['DOGE/USDT'];
    (bot as any).runtimeState.setupSnapshot = {
      positionSize: 3.0,
      maxPortfolioExposure: 1000,
      targetEntryPrice: 0.10,
      strategy: 'ScalperV2'
    };
    mockStateVars.mockCycleResults = [
      {
        strategyId: 'ScalperV2',
        hasSignal: true,
        confidenceScore: 85,
        metadata: {
          signal: {
            type: 'BUY',
            signalPrice: 0.10,
            stopLoss: 0.095,
            takeProfit: 0.11,
            timeframe: '5m',
            riskAssessment: {
              riskClassification: 'LOW',
              positionSizeRecommendation: 3.0
            }
          },
          targetTimeframe: '5m',
          reasoning: ['DOGE technical setup']
        }
      }
    ];

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);
    expect(mockSendTradeNotification).not.toHaveBeenCalled();
  });

  // --- 10. Valid execution produces an executable alert with approved quantity ---
  it("TEST 10: Valid execution produces executable alert with approved quantity", async () => {
    (bot as any).runtimeState.setupSnapshot.positionSize = 1000;

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(1);
    const alert = storedAlerts[0];
    expect(alert.isExecutable).toBe(true);
    expect(alert.ineligibilityReason).toBeUndefined();
    expect(alert.quantity).toBe(0.02);
    expect(alert.effectiveNotional).toBe(1000);
    expect(alert.positionSize).toBe(1000);
    expect(alert.estimatedPnl).toBeGreaterThan(0);

    // Verify FCM notification carried approved quantity and isExecutable: true
    expect(mockSendTradeNotification).toHaveBeenCalledTimes(1);
    const notifArg = mockSendTradeNotification.mock.calls[0][3];
    expect(notifArg.isExecutable).toBe(true);
    expect(notifArg.quantity).toBe(0.02);
  });

  // --- 11. Maximum quantity clamping preserves correct executable sizing ---
  it("TEST 11: Maximum quantity clamping preserves correct executable sizing", async () => {
    // Budget $5,000, price $50,000, maxOrderQty = 0.05 (unclamped = 0.1)
    (bot as any).runtimeState.setupSnapshot.positionSize = 5000;
    mockStateVars.mockCycleResults[0].metadata.signal.riskAssessment.positionSizeRecommendation = 5000;
    mockStateVars.mockMarketMetadata['BTC/USDT'] = {
      precision: { amount: 0.001, price: 1.0 },
      limits: { cost: { min: 5.0 }, amount: { min: 0.001, max: 0.05 }, marketAmount: { max: 0.05 } }
    };

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(1);
    const alert = storedAlerts[0];
    expect(alert.isExecutable).toBe(true);
    expect(alert.quantity).toBe(0.05);
    expect(alert.positionSize).toBe(2500); // Clamped effective notional (0.05 * 50000)
    expect(alert.effectiveNotional).toBe(2500);
  });

  // --- 12. Unsupported short signals remain suppressed ---
  it("TEST 12: Unsupported short signals remain suppressed (Candidate-Specific Technical Gate)", async () => {
    vi.spyOn(StrategyRegistry.getInstance(), 'getManifest').mockReturnValue({
      id: 'ScalperV2',
      name: 'ScalperV2',
      supportsShort: false,
    } as any);
    mockStateVars.mockCycleResults[0].metadata.signal.type = 'SELL';
    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);
    expect(mockSendTradeNotification).not.toHaveBeenCalled();
  });

  // --- 13. EXTREME risk remains suppressed ---
  it("TEST 13: EXTREME risk remains suppressed (Technical Gate)", async () => {
    mockStateVars.mockCycleResults[0].metadata.signal.riskAssessment.riskClassification = 'EXTREME';

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);
    expect(mockSendTradeNotification).not.toHaveBeenCalled();
  });

  // --- 14. Directional/MTF failure remains suppressed ---
  it("TEST 14: Directional/MTF failure remains suppressed (Technical Gate)", async () => {
    vi.spyOn(DirectionalMtfArbitrator, 'evaluateCandidate').mockReturnValue({
      passed: false,
      gate: 'HTF_CONFLICT',
      reasoning: 'Higher timeframe is strongly bearish'
    });

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);
    expect(mockSendTradeNotification).not.toHaveBeenCalled();
  });

  // --- 15. Active alert, in-flight intent and open position prevent duplicates ---
  it("TEST 15: Active alert, in-flight intent and open position prevent duplicates (Lifecycle Gates)", async () => {
    // 15a: Active alert within 300s
    (bot as any).runtimeState.alerts = [
      {
        id: 'existing-alert-1',
        symbol: 'BTC/USDT',
        status: 'pending',
        timestamp: new Date().toISOString()
      }
    ];

    await bot.alarm();
    let storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);

    // 15b: In-flight WAL intent
    (bot as any).runtimeState.alerts = [];
    (bot as any).runtimeState.activeIntents.set('intent-1', {
      intentId: 'intent-1',
      symbol: 'BTC/USDT',
      status: 'DISPATCHED'
    });

    await bot.alarm();
    storedAlerts = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);

    // 15c: Existing open position
    (bot as any).runtimeState.activeIntents.clear();
    (bot as any).runtimeState.activePositions = [
      { id: 'pos-btc', symbol: 'BTC/USDT', status: 'OPEN', side: 'BUY' }
    ];

    await bot.alarm();
    storedAlerts = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);
  });

  // --- 16. Exactly one alert per symbol per cycle remains enforced ---
  it("TEST 16: Exactly one alert per symbol per cycle remains enforced", async () => {
    // Two strategies return qualified signals for BTC
    mockStateVars.mockCycleResults = [
      {
        strategyId: 'ScalperV2',
        hasSignal: true,
        confidenceScore: 85,
        metadata: {
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            stopLoss: 49500,
            takeProfit: 51000,
            timeframe: '5m',
            riskAssessment: { riskClassification: 'LOW', positionSizeRecommendation: 1000 }
          },
          targetTimeframe: '5m'
        }
      },
      {
        strategyId: 'Momentum',
        hasSignal: true,
        confidenceScore: 90,
        metadata: {
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            stopLoss: 49000,
            takeProfit: 52000,
            timeframe: '5m',
            riskAssessment: { riskClassification: 'LOW', positionSizeRecommendation: 1000 }
          },
          targetTimeframe: '5m'
        }
      }
    ];

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(1);
    expect(storedAlerts[0].strategy).toBe('ScalperV2_NEW'); // Priority 1 strategy won
  });

  // --- 17. Non-positive budget suppresses alert creation ---
  it("TEST 17: Non-positive budget suppresses alert creation (INSUFFICIENT_BUDGET)", async () => {
    (bot as any).runtimeState.setupSnapshot.positionSize = 0; // Trigger INSUFFICIENT_BUDGET
    (bot as any).runtimeState.positionSize = 0;
    mockStateVars.mockCycleResults[0].metadata.signal.riskAssessment.positionSizeRecommendation = 0;

    await bot.alarm();

    const storedAlerts: TradeAlert[] = mockStorage.get('alerts') || [];
    expect(storedAlerts.length).toBe(0);
    expect(mockSendTradeNotification).not.toHaveBeenCalled();
  });

  // --- 18. Stage 2.1 explicit-false execution rejection still works ---
  it("TEST 18: Stage 2.1 explicit-false execution rejection still works on signal-only alert", async () => {
    // Construct signal-only alert in storage
    const signalOnlyAlert: TradeAlert = {
      id: 'alert-signal-only-test',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49500,
      takeProfit: 51000,
      strategy: 'ScalperV2_NEW',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      generation: 1,
      source: 'AUTONOMOUS',
      dispatchState: 'SENT',
      isExecutable: false,
      ineligibilityReason: 'INSUFFICIENT_BUDGET'
    };
    mockStorage.set('alerts', [signalOnlyAlert]);
    (bot as any).runtimeState.alerts = [signalOnlyAlert];

    const req = new Request('https://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertId: 'alert-signal-only-test',
        userId: 'user-stage22',
        symbol: 'BTC/USDT',
        side: 'BUY',
        quantity: 0.02
      })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.code).toBe('ALERT_NOT_EXECUTABLE');
    expect(body.error).toContain('INSUFFICIENT_BUDGET');
    expect(mockCreateOrder).not.toHaveBeenCalled(); // Zero Bybit calls
  });

  // --- 19. Legacy alert compatibility remains intact ---
  it("TEST 19: Legacy alert compatibility remains intact", async () => {
    // 19a: Legacy alert with valid positive quantity executes successfully
    const legacyValidAlert: TradeAlert = {
      id: 'alert-legacy-valid',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49500,
      takeProfit: 51000,
      positionSize: 1000,
      quantity: 0.02,
      strategy: 'ScalperV2_NEW',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      generation: 1,
      source: 'AUTONOMOUS',
      dispatchState: 'SENT',
      isExecutable: undefined // Legacy alert
    };

    // 19b: Legacy alert with missing quantity rejected
    const legacyMissingQtyAlert: TradeAlert = {
      id: 'alert-legacy-missing-qty',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49500,
      takeProfit: 51000,
      positionSize: 1000,
      quantity: undefined,
      strategy: 'ScalperV2_NEW',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      generation: 1,
      source: 'AUTONOMOUS',
      dispatchState: 'SENT',
      isExecutable: undefined // Legacy alert
    };

    mockStorage.set('alerts', [legacyValidAlert, legacyMissingQtyAlert]);
    (bot as any).runtimeState.alerts = [legacyValidAlert, legacyMissingQtyAlert];

    // Attempt execution on legacy alert with missing quantity
    const reqMissing = new Request('https://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertId: 'alert-legacy-missing-qty',
        userId: 'user-stage22',
        symbol: 'BTC/USDT',
        side: 'BUY'
      })
    });
    const resMissing = await bot.fetch(reqMissing);
    expect(resMissing.status).toBe(409);
    const bodyMissing = await resMissing.json() as any;
    expect(bodyMissing.code).toBe('MISSING_APPROVED_QUANTITY');

    // Attempt execution on legacy alert with valid approved quantity
    const reqValid = new Request('https://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertId: 'alert-legacy-valid',
        userId: 'user-stage22',
        symbol: 'BTC/USDT',
        side: 'BUY',
        quantity: 0.02
      })
    });
    const resValid = await bot.fetch(reqValid);
    expect(resValid.status).toBe(200);
    const bodyValid = await resValid.json() as any;
    expect(bodyValid.success).toBe(true);
    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
  });
});
