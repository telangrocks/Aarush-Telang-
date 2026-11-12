import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionEligibilityGate } from "../../src/engine/scanner/ExecutionEligibilityGate";
import { TradeValidator } from "../../src/validation/TradeValidator";
import { mapScanResultToCandidates } from "../../src/handlers/exchange";
import { TradingBot, TradeAlert } from "../../src/trading-bot";
import { SymbolTradingRules, ValidationErrorReason } from "../../src/exchanges/types";

// Mock security crypto
vi.mock("../../src/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key"),
  encrypt: vi.fn().mockResolvedValue({ iv: "mock_iv", encrypted: "mock_enc", salt: "mock_salt" })
}));

// Mock exchanges adapter with multi-market support
const mockFetchMarket = vi.fn();
const mockFetchMarkets = vi.fn();
const mockFetchKlines = vi.fn().mockImplementation((sym: string) => {
  const basePrice = sym.includes('GRAM') ? 1.249 : 50000;
  const step = sym.includes('GRAM') ? 0.01 : 10.0;
  const now = Date.now();
  const stepMs = 3600000;
  return Promise.resolve(
    Array.from({ length: 60 }, (_, i) => {
      const openTime = now - (60 - i) * stepMs;
      const price = basePrice + i * step;
      return {
        openTime,
        timestamp: openTime,
        closeTime: openTime + stepMs,
        open: price,
        high: price + step * 0.5,
        low: price - step * 0.5,
        close: price,
        volume: 1000
      };
    })
  );
});
const mockFetchTicker = vi.fn().mockImplementation((sym: string) => {
  const price = sym.includes('GRAM') ? 1.249 : 50000;
  return Promise.resolve({
    symbol: sym.replace('/', ''),
    last: price,
    bid: price * 0.999,
    ask: price * 1.001,
    high: price * 1.05,
    low: price * 0.95,
    volume: 1000,
    quoteVolume: 5000000
  });
});
vi.mock("../../src/exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: (...args: any[]) => mockFetchTicker(...args),
        fetchKlines: (...args: any[]) => mockFetchKlines(...args),
        fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 10000 }, total: { USDT: 10000 } }),
        fetchMarkets: (...args: any[]) => mockFetchMarkets(...args),
        fetchMarket: (...args: any[]) => mockFetchMarket(...args),
        createOrder: vi.fn(),
        supportsOco: vi.fn().mockReturnValue(false),
      }),
      executeIdempotentOrder: vi.fn(),
    },
    normalizeEnvironment: vi.fn().mockReturnValue('testnet'),
    normalizeRegion: vi.fn().mockReturnValue('global'),
  };
});

// Mock StrategyOrchestrator
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

describe("P0: Budget-Aware Execution Eligibility & Multi-Ticker Continuation Acceptance Suite", () => {
  // --------------------------------------------------------------------------
  // AC-01: Forensic Case CID-20261025010731-0be570e5 (GRAM/USDT at $1.249 with $5.00 budget)
  // --------------------------------------------------------------------------
  it("AC-01: rejects GRAM/USDT when budget is $5.00 USDT at price $1.249 due to quantization shortfall ($4.9960 < $5.00)", () => {
    const result = ExecutionEligibilityGate.evaluate({
      tradeAmountUsdt: 5.0,
      currentPrice: 1.249,
      qtyStep: 0.1,
      minOrderQty: 0.1,
      minNotional: 5.0,
      maxOrderQty: 100000,
    });

    expect(result.isExecutable).toBe(false);
    expect(result.quantizedQty).toBe(4.0); // floor(5.0 / 1.249 / 0.1) * 0.1 = 40 * 0.1 = 4.0
    expect(result.postRoundingNotional).toBeCloseTo(4.996, 4);
    expect(result.rejectionReason).toContain("Post-rounding notional ($4.9960 USDT) < minNotional ($5.00 USDT)");
  });

  // --------------------------------------------------------------------------
  // AC-02: Boundary Case (GRAM/USDT at $1.250 with $5.00 budget)
  // --------------------------------------------------------------------------
  it("AC-02: accepts GRAM/USDT when price recovers to $1.250 with $5.00 budget (exact $5.0000 notional)", () => {
    const result = ExecutionEligibilityGate.evaluate({
      tradeAmountUsdt: 5.0,
      currentPrice: 1.250,
      qtyStep: 0.1,
      minOrderQty: 0.1,
      minNotional: 5.0,
      maxOrderQty: 100000,
    });

    expect(result.isExecutable).toBe(true);
    expect(result.quantizedQty).toBe(4.0); // floor(5.0 / 1.250 / 0.1) * 0.1 = 40 * 0.1 = 4.0
    expect(result.postRoundingNotional).toBe(5.0);
    expect(result.rejectionReason).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // AC-04: Sub-minimum Capital Allocation Rejection
  // --------------------------------------------------------------------------
  it("AC-04: rejects order when user budget ($4.99 USDT) is strictly below exchange minNotional ($5.00 USDT)", () => {
    const result = ExecutionEligibilityGate.evaluate({
      tradeAmountUsdt: 4.99,
      currentPrice: 1.25,
      qtyStep: 0.1,
      minOrderQty: 0.1,
      minNotional: 5.0,
      maxOrderQty: 100000,
    });

    expect(result.isExecutable).toBe(false);
    expect(result.quantizedQty).toBe(0);
    expect(result.rejectionReason).toContain("is below exchange minNotional");
  });

  // --------------------------------------------------------------------------
  // AC-05: Sub-minimum Order Quantity Rejection
  // --------------------------------------------------------------------------
  it("AC-05: rejects order when quantized quantity drops below exchange minOrderQty", () => {
    const result = ExecutionEligibilityGate.evaluate({
      tradeAmountUsdt: 5.0,
      currentPrice: 65000,
      qtyStep: 0.001,
      minOrderQty: 0.001,
      minNotional: 5.0,
      maxOrderQty: 100000,
    });

    expect(result.isExecutable).toBe(false);
    expect(result.quantizedQty).toBe(0);
    expect(result.rejectionReason).toContain("Quantized qty (0) < minOrderQty (0.001)");
  });

  // --------------------------------------------------------------------------
  // AC-06: Fail-Closed Metadata Validation
  // --------------------------------------------------------------------------
  it("AC-06: fails closed with explicit diagnostic when qtyStep is missing, non-positive or NaN (never defaults to 0.00001)", () => {
    const zeroStep = ExecutionEligibilityGate.evaluate({
      tradeAmountUsdt: 5.0,
      currentPrice: 1.25,
      qtyStep: 0,
      minOrderQty: 0.1,
      minNotional: 5.0,
      maxOrderQty: 100000,
    });
    expect(zeroStep.isExecutable).toBe(false);
    expect(zeroStep.rejectionReason).toBe("Invalid exchange quantity step size (must be positive and finite)");

    const negativeStep = ExecutionEligibilityGate.evaluate({
      tradeAmountUsdt: 5.0,
      currentPrice: 1.25,
      qtyStep: -0.1,
      minOrderQty: 0.1,
      minNotional: 5.0,
      maxOrderQty: 100000,
    });
    expect(negativeStep.isExecutable).toBe(false);
    expect(negativeStep.rejectionReason).toBe("Invalid exchange quantity step size (must be positive and finite)");

    const nanStep = ExecutionEligibilityGate.evaluate({
      tradeAmountUsdt: 5.0,
      currentPrice: 1.25,
      qtyStep: NaN,
      minOrderQty: 0.1,
      minNotional: 5.0,
      maxOrderQty: 100000,
    });
    expect(nanStep.isExecutable).toBe(false);
    expect(nanStep.rejectionReason).toBe("Invalid exchange quantity step size (must be positive and finite)");
  });

  // --------------------------------------------------------------------------
  // AC-07: TradeValidator Precision Formatting (Resolving F-EXEC-05)
  // --------------------------------------------------------------------------
  it("AC-07: TradeValidator formats shortfall notional to 4 decimal places ($4.9960 USDT), avoiding confusing '$5.00 USDT' string", () => {
    const mockRules: SymbolTradingRules = {
      schemaVersion: "2.0",
      symbol: "GRAMUSDT",
      exchange: "bybit",
      baseAsset: "GRAM",
      quoteAsset: "USDT",
      minNotional: 5.0,
      maxOrderQty: 100000,
      minQty: 0.1,
      maxQty: 100000.0,
      stepSize: 0.1,
      tickSize: 0.001,
      minPrice: 0.001,
      maxPrice: 1000.0,
      contractSize: 1.0,
      lastUpdated: Date.now(),
    };

    // User attempts trade with 4.0 GRAM at price 1.249 -> notional = 4.996 USDT < minNotional 5.0 USDT
    const res = TradeValidator.validate(
      { symbol: "GRAMUSDT", entryPrice: 1.249, quantity: 4.0 },
      mockRules
    );

    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe(ValidationErrorReason.MIN_NOTIONAL_FAILED);
    expect(res.errorMessage).toBe("Order value ($4.9960 USDT) is below exchange minimum notional requirement of $5.00 USDT.");
    // Must NOT contain rounded "$5.00 USDT is below"
    expect(res.errorMessage).not.toContain("Order value ($5.00 USDT)");
  });

  // --------------------------------------------------------------------------
  // AC-08: Budget Ceiling Invariant: postRoundingNotional <= tradeAmountUsdt
  // --------------------------------------------------------------------------
  it("AC-08: postRoundingNotional never exceeds configured user budget across various step sizes and prices", () => {
    const testCases = [
      { budget: 5.0, price: 1.249, step: 0.1 },
      { budget: 5.0, price: 1.250, step: 0.1 },
      { budget: 10.0, price: 140.0, step: 0.01 },
      { budget: 25.0, price: 65432.1, step: 0.001 },
      { budget: 100.0, price: 0.003456, step: 10 },
      { budget: 500.0, price: 3.14159, step: 0.0001 },
    ];

    for (const tc of testCases) {
      const res = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: tc.budget,
        currentPrice: tc.price,
        qtyStep: tc.step,
        minOrderQty: tc.step,
        minNotional: 5.0,
        maxOrderQty: 100000,
      maxOrderQty: 100000,
      });

      expect(res.postRoundingNotional).toBeLessThanOrEqual(tc.budget + 1e-9);
    }
  });

  // --------------------------------------------------------------------------
  // AC-09: Discovery DTO Authoritative qtyStep Mapping (Resolving F-EXEC-03)
  // --------------------------------------------------------------------------
  it("AC-09: mapScanResultToCandidates strictly maps marketQuality.qtyStep and does not fall back to minOrderQty", () => {
    const scanResult = {
      topOpportunities: [
        {
          symbol: 'BTC/USDT',
          opportunityId: 'BTC/USDT:ScalperV2:LONG',
          opportunityScore: 95,
          dominantDirection: 'LONG',
          strategyCompatibility: [{ strategyId: 'ScalperV2' }],
          marketQuality: {
            turnover24hUsdt: 50_000_000,
            priceChangePercent24h: 2.5,
            minNotionalUsdt: 5,
            minOrderQty: 0.001,
            qtyStep: 0.0001, // Distinct from minOrderQty!
            tickSize: 0.1,
          },
          timeframes: { '15m': { closePrice: 50000, trend: 'BULL' } }
        },
        {
          symbol: 'ETH/USDT',
          opportunityId: 'ETH/USDT:Momentum:LONG',
          opportunityScore: 90,
          dominantDirection: 'LONG',
          strategyCompatibility: [{ strategyId: 'Momentum' }],
          marketQuality: {
            turnover24hUsdt: 30_000_000,
            priceChangePercent24h: 1.5,
            minNotionalUsdt: 5,
            minOrderQty: 0.01,
            // qtyStep omitted or null
            tickSize: 0.01,
          },
          timeframes: { '15m': { closePrice: 3000, trend: 'BULL' } }
        }
      ]
    };

    const candidates = mapScanResultToCandidates(scanResult);

    expect(candidates).toHaveLength(2);
    // BTC: qtyStep preserves genuine 0.0001, distinct from minOrderQty 0.001
    expect(candidates[0].symbol).toBe('BTC');
    expect(candidates[0].minOrderQty).toBe(0.001);
    expect(candidates[0].qtyStep).toBe(0.0001);

    // ETH: missing qtyStep maps to null (fail-closed), NOT minOrderQty 0.01
    expect(candidates[1].symbol).toBe('ETH');
    expect(candidates[1].minOrderQty).toBe(0.01);
    expect(candidates[1].qtyStep).toBeNull();
  });

  // --------------------------------------------------------------------------
  // AC-03-MULTI: Autonomous Alarm Cycle Continuation Across Multiple Tickers
  // --------------------------------------------------------------------------
  describe("AC-03-MULTI: Autonomous Multi-Ticker Continuation Invariant", () => {
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
          list: async () => mockStorage,
        },
        blockConcurrencyWhile: async (cb: any) => cb()
      };

      mockDb = {
        prepare: vi.fn().mockImplementation((query: string) => ({
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
        }))
      };

      mockEnv = {
        DB: mockDb,
        ENCRYPTION_KEY: "mock_key_0123456789012345678901",
        FCM_SERVER_KEY: "mock_fcm_key",
        ENVIRONMENT: "test",
        GLOBAL_TRADING_HALT: "false"
      };

      // Markets configuration: GRAM/USDT has qtyStep 0.1, BTC/USDT has qtyStep 0.00001
      const marketsList = [
        {
          id: 'GRAMUSDT',
          symbol: 'GRAM/USDT',
          quote: 'USDT',
          active: true,
          category: 'linear',
          precision: { amount: 0.1, price: 0.001 },
          limits: { cost: { min: 5.0 }, amount: { min: 0.1, max: 100000 } }
        },
        {
          id: 'BTCUSDT',
          symbol: 'BTC/USDT',
          quote: 'USDT',
          active: true,
          category: 'linear',
          precision: { amount: 0.00001, price: 1.0 },
          limits: { cost: { min: 5.0 }, amount: { min: 0.00001, max: 1000 } }
        }
      ];

      mockFetchTicker.mockImplementation((sym: string) => {
        const price = sym.includes('GRAM') ? 1.249 : 50000;
        return Promise.resolve({
          symbol: sym.replace('/', ''),
          last: price,
          bid: price * 0.999,
          ask: price * 1.001,
          high: price * 1.05,
          low: price * 0.95,
          volume: 1000,
          quoteVolume: 5000000
        });
      });
      mockFetchMarkets.mockResolvedValue(marketsList);
      mockFetchMarket.mockImplementation(async (sym: string) => {
        return marketsList.find(m => m.symbol === sym || m.id === sym.replace('/', '')) || null;
      });
    });

    it("AC-03-MULTI: skips execution-ineligible ticker (GRAM/USDT) with diagnostic telemetry and continues alarm cycle to process subsequent eligible ticker (BTC/USDT)", async () => {
      const bot = new TradingBot(mockState, mockEnv);

      // Configure monitored symbols with both GRAM/USDT and BTC/USDT in current alarm cycle
      mockStorage.set("isActive", true);
      mockStorage.set("userId", "user-multi-ticker-test");
      mockStorage.set("strategy", "ScalperV2");
      mockStorage.set("positionSize", 5.0); // Exact $5.00 USDT budget
      mockStorage.set("monitoredSymbols", ["GRAM/USDT", "BTC/USDT"]);
      mockStorage.set("lock:alarmGeneration", 1);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId: 'user-multi-ticker-test',
        budgetUsdt: 5.0,
        approvedSymbols: ['GRAM/USDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'testnet',
        accountFingerprint: 'bybit:testnet',
        orderType: 'ALL',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        symbolMetadataSnapshot: {}
      });

      // Mock Orchestrator: Both tickers generate qualified BUY signals
      mockExecuteCycle.mockImplementation(async (symbol: string) => {
        if (symbol === 'GRAM/USDT') {
          return [{
            strategyId: 'ScalperV2',
            confidenceScore: 92,
            hasSignal: true,
            metadata: {
              targetTimeframe: '5m',
              signal: {
                type: 'BUY',
                signalPrice: 1.249, // GRAM price 1.249 -> quantized notional 4.996 < 5.00 minNotional!
                stopLoss: 1.23,
                takeProfit: 1.30,
                timeframe: '5m',
                riskAssessment: { positionSizeRecommendation: 5.0 }
              }
            }
          }];
        } else if (symbol === 'BTC/USDT') {
          return [{
            strategyId: 'Momentum',
            confidenceScore: 88,
            hasSignal: true,
            metadata: {
              targetTimeframe: '5m',
              signal: {
                type: 'BUY',
                signalPrice: 50000.0, // BTC price 50000 -> quantized 0.00010 * 50000 = 5.00 >= 5.00 minNotional!
                stopLoss: 49000.0,
                takeProfit: 52000.0,
                timeframe: '5m',
                riskAssessment: { positionSizeRecommendation: 5.0 }
              }
            }
          }];
        }
        return [];
      });

      // Spy on telemetry sink emit
      const emitSpy = vi.spyOn((bot as any).telemetrySink, 'emit');

      // Execute autonomous alarm cycle
      await bot.alarm();

      // Retrieve persisted alerts
      const alerts: TradeAlert[] = mockStorage.get("alerts") || [];

      // 1. GRAM/USDT must NOT have an alert (suppressed by ExecutionEligibilityGate)
      const gramAlert = alerts.find(a => a.symbol === 'GRAM/USDT');
      expect(gramAlert).toBeUndefined();

      // 2. Telemetry must explicitly record that GRAM/USDT was skipped at FINAL_DISPATCH_GATE with EXECUTION_INELIGIBLE
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'FINAL_DISPATCH_GATE',
          symbol: 'GRAM/USDT',
          payload: expect.objectContaining({
            passed: false,
            gate: 'BUDGET_INSUFFICIENT_AT_CURRENT_PRICE',
            budget: 5.0,
            currentPrice: 1.249,
            qtyStep: 0.1,
            rejectionReason: expect.stringContaining("Post-rounding notional ($4.9960 USDT) < minNotional ($5.00 USDT)"),
          })
        })
      );

      // 3. BTC/USDT MUST have an actionable alert generated (alarm cycle continued!)
      const btcAlert = alerts.find(a => a.symbol === 'BTC/USDT');
      expect(btcAlert).toBeDefined();
      expect(btcAlert?.symbol).toBe('BTC/USDT');
      expect(btcAlert?.positionSize).toBe(5.0);
      expect(btcAlert?.signalPrice).toBe(50000.0);
      expect(btcAlert?.status).toBe('pending');

      // 4. Telemetry must record that BTC/USDT alert was created
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'ALERT_CREATED',
          symbol: 'BTC/USDT',
          strategyId: 'Momentum_NEW'
        })
      );
    });
  });

        // --------------------------------------------------------------------------
  // AC-10: Strict Strategy Risk Distance & Fail-Closed Safety Suite
  // --------------------------------------------------------------------------
  describe("AC-10: Strict Strategy Risk Distance & Fail-Closed Safety Suite", () => {
    let mockStorage: Map<string, any>;
    let mockState: any;
    let mockEnv: any;

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
          list: async () => mockStorage,
        },
        blockConcurrencyWhile: async (cb: any) => cb()
      };

      mockEnv = {
        DB: {
          prepare: vi.fn().mockImplementation(() => ({
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
          }))
        },
        ENCRYPTION_KEY: "mock_key_0123456789012345678901",
        FCM_SERVER_KEY: "mock_fcm_key",
        ENVIRONMENT: "test",
        GLOBAL_TRADING_HALT: "false"
      };

      mockStorage.set("isActive", true);
      mockStorage.set("userId", "user-risk-test");
      mockStorage.set("strategy", "ScalperV2");
      mockStorage.set("positionSize", 10.0);
      mockStorage.set("monitoredSymbols", ["BTC/USDT"]);
      mockStorage.set("lock:alarmGeneration", 1);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId: 'user-risk-test',
        budgetUsdt: 10.0,
        approvedSymbols: ['BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'testnet',
        accountFingerprint: 'bybit:testnet',
        orderType: 'ALL',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        symbolMetadataSnapshot: {}
      });

      mockFetchMarkets.mockResolvedValue([
        {
          id: 'BTCUSDT',
          symbol: 'BTC/USDT',
          quote: 'USDT',
          active: true,
          category: 'linear',
          precision: { amount: 0.00001, price: 0.1 },
          limits: { cost: { min: 5.0 }, amount: { min: 0.00001, max: 1000 } }
        }
      ]);
      mockFetchMarket.mockResolvedValue({
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        quote: 'USDT',
        active: true,
        category: 'linear',
        precision: { amount: 0.00001, price: 0.1 },
        limits: { cost: { min: 5.0 }, amount: { min: 0.00001, max: 1000 } }
      });
      mockFetchTicker.mockImplementation((sym: string) => {
        return Promise.resolve({
          symbol: 'BTCUSDT',
          last: 50000.0,
          bid: 49999.0,
          ask: 50001.0,
          high: 51000.0,
          low: 49000.0,
          volume: 1000,
          quoteVolume: 50000000
        });
      });
      mockFetchKlines.mockImplementation((sym: string) => {
        const basePrice = 50000;
        const step = 10.0;
        const now = Date.now();
        const stepMs = 3600000;
        return Promise.resolve(
          Array.from({ length: 60 }, (_, i) => {
            const openTime = now - (60 - i) * stepMs;
            const price = basePrice + i * step;
            return {
              openTime,
              timestamp: openTime,
              closeTime: openTime + stepMs,
              open: price,
              high: price + step * 0.5,
              low: price - step * 0.5,
              close: price,
              volume: 1000
            };
          })
        );
      });
    });

    it("1 & 7: Re-anchors valid BUY strategy risk distances to fresh price while preserving ATR distances", async () => {
      mockFetchTicker.mockImplementation(() => Promise.resolve({ symbol: 'BTCUSDT', last: 50500.0 }));
      mockExecuteCycle.mockResolvedValueOnce([{
        strategyId: 'ScalperV2',
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: {
            type: 'BUY',
            signalPrice: 50000.0,
            stopLoss: 49000.0,
            takeProfit: 52000.0,
            timeframe: '5m',
            riskAssessment: {
              stopLossDistance: 1000.0,
              takeProfitDistance: 2000.0,
              riskRewardRatio: 2.0
            }
          }
        }
      }]);

      const bot = new TradingBot(mockState, mockEnv);
      await bot.alarm();

      const alerts: TradeAlert[] = mockStorage.get("alerts") || [];
      const alert = alerts.find(a => a.symbol === 'BTC/USDT');
      expect(alert).toBeDefined();
      expect(alert?.side).toBe('BUY');
      expect(alert?.entryPrice).toBe(50500.0);
      expect(alert?.stopLoss).toBe(49500.0);
      expect(alert?.takeProfit).toBe(52500.0);
      expect(alert?.entryPrice! - alert?.stopLoss!).toBe(1000.0);
      expect(alert?.takeProfit! - alert?.entryPrice!).toBe(2000.0);
    });

    it("2 & 7: Re-anchors valid SELL strategy risk distances to fresh price while preserving ATR distances", async () => {
      const now = Date.now();
      const stepMs = 3600000;
      const bearishKlines = Array.from({ length: 60 }, (_, i) => {
        const openTime = now - (60 - i) * stepMs;
        const price = 55000.0 - i * 10.0;
        return {
          openTime,
          timestamp: openTime,
          closeTime: openTime + stepMs,
          open: price,
          high: price + 5.0,
          low: price - 5.0,
          close: price,
          volume: 1000
        };
      });

      mockFetchKlines.mockResolvedValue(bearishKlines);
      mockFetchTicker.mockImplementation(() => Promise.resolve({ symbol: 'BTCUSDT', last: 49500.0 }));

      mockExecuteCycle.mockResolvedValueOnce([{
        strategyId: 'ScalperV2',
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: {
            type: 'SELL',
            signalPrice: 50000.0,
            stopLoss: 51000.0,
            takeProfit: 48000.0,
            timeframe: '5m',
            riskAssessment: {
              stopLossDistance: 1000.0,
              takeProfitDistance: 2000.0,
              riskRewardRatio: 2.0
            }
          }
        }
      }]);

      const bot = new TradingBot(mockState, mockEnv);
      await bot.alarm();

      const alerts: TradeAlert[] = mockStorage.get("alerts") || [];
      const alert = alerts.find(a => a.symbol === 'BTC/USDT');
      expect(alert).toBeDefined();
      expect(alert?.side).toBe('SELL');
      expect(alert?.entryPrice).toBe(49500.0);
      expect(alert?.stopLoss).toBe(50500.0);
      expect(alert?.takeProfit).toBe(47500.0);
      expect(alert?.stopLoss! - alert?.entryPrice!).toBe(1000.0);
      expect(alert?.entryPrice! - alert?.takeProfit!).toBe(2000.0);
    });

    it("3 & 6: Fails closed when risk assessment and explicit SL/TP are missing (zero alert, zero FCM)", async () => {
      mockExecuteCycle.mockResolvedValueOnce([{
        strategyId: 'ScalperV2',
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: {
            type: 'BUY',
            signalPrice: 50000.0,
            stopLoss: null,
            takeProfit: null,
            timeframe: '5m',
            riskAssessment: null
          }
        }
      }]);

      const bot = new TradingBot(mockState, mockEnv);
      const emitSpy = vi.spyOn((bot as any).telemetrySink, 'emit');
      await bot.alarm();

      const alerts: TradeAlert[] = mockStorage.get("alerts") || [];
      expect(alerts).toHaveLength(0);
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'FINAL_DISPATCH_GATE',
          payload: expect.objectContaining({
            gate: 'MISSING_STRATEGY_RISK_DISTANCES',
            passed: false
          })
        })
      );
    });

    it("4 & 6: Fails closed when risk distances are zero, negative, NaN or infinite", async () => {
      const invalidDistances = [
        { sl: 0, tp: 1000 },
        { sl: -100, tp: 1000 },
        { sl: NaN, tp: 1000 },
        { sl: Infinity, tp: 1000 },
        { sl: 1000, tp: 0 },
        { sl: 1000, tp: -50 },
        { sl: 1000, tp: NaN },
        { sl: 1000, tp: Infinity }
      ];

      for (const dist of invalidDistances) {
        mockStorage.set("alerts", []);
        mockExecuteCycle.mockResolvedValueOnce([{
          strategyId: 'ScalperV2',
          confidenceScore: 90,
          hasSignal: true,
          metadata: {
            targetTimeframe: '5m',
            signal: {
              type: 'BUY',
              signalPrice: 50000.0,
              timeframe: '5m',
              riskAssessment: {
                stopLossDistance: dist.sl,
                takeProfitDistance: dist.tp
              }
            }
          }
        }]);

        const bot = new TradingBot(mockState, mockEnv);
        await bot.alarm();

        const alerts: TradeAlert[] = mockStorage.get("alerts") || [];
        expect(alerts).toHaveLength(0);
      }
    });

    it("5 & 6: Fails closed when BUY signal has SL above entry or TP below entry", async () => {
      mockExecuteCycle.mockResolvedValueOnce([{
        strategyId: 'ScalperV2',
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: {
            type: 'BUY',
            signalPrice: 50000.0,
            stopLoss: 51000.0,
            takeProfit: 52000.0,
            timeframe: '5m'
          }
        }
      }]);

      const bot = new TradingBot(mockState, mockEnv);
      const emitSpy = vi.spyOn((bot as any).telemetrySink, 'emit');
      await bot.alarm();

      const alerts: TradeAlert[] = mockStorage.get("alerts") || [];
      expect(alerts).toHaveLength(0);
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'FINAL_DISPATCH_GATE',
          payload: expect.objectContaining({
            gate: 'MISSING_STRATEGY_RISK_DISTANCES',
            passed: false
          })
        })
      );
    });

    it("5 & 6: Fails closed when SELL signal has SL below entry or TP above entry", async () => {
      const now = Date.now();
      const stepMs = 3600000;
      const bearishKlines = Array.from({ length: 60 }, (_, i) => {
        const openTime = now - (60 - i) * stepMs;
        const price = 55000.0 - i * 10.0;
        return {
          openTime,
          timestamp: openTime,
          closeTime: openTime + stepMs,
          open: price,
          high: price + 5.0,
          low: price - 5.0,
          close: price,
          volume: 1000
        };
      });

      mockFetchKlines.mockResolvedValue(bearishKlines);

      mockExecuteCycle.mockResolvedValueOnce([{
        strategyId: 'ScalperV2',
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: {
            type: 'SELL',
            signalPrice: 50000.0,
            stopLoss: 49000.0,
            takeProfit: 48000.0,
            timeframe: '5m'
          }
        }
      }]);

      const bot = new TradingBot(mockState, mockEnv);
      const emitSpy = vi.spyOn((bot as any).telemetrySink, 'emit');
      await bot.alarm();

      const alerts: TradeAlert[] = mockStorage.get("alerts") || [];
      expect(alerts).toHaveLength(0);
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'FINAL_DISPATCH_GATE',
          payload: expect.objectContaining({
            gate: 'MISSING_STRATEGY_RISK_DISTANCES',
            passed: false
          })
        })
      );
    });

    // ── Focused Regression Tests for Micro-Correction ─────────────────────────

    it("REG-01: Rejects signal with valid riskAssessment when explicit SL is NaN", async () => {
      mockExecuteCycle.mockResolvedValueOnce([{
        strategyId: 'ScalperV2',
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: {
            type: 'BUY',
            signalPrice: 50000.0,
            stopLoss: NaN, // Explicit NaN SL must be strictly rejected
            takeProfit: 52000.0,
            timeframe: '5m',
            riskAssessment: {
              stopLossDistance: 1000.0,
              takeProfitDistance: 2000.0
            }
          }
        }
      }]);

      const bot = new TradingBot(mockState, mockEnv);
      const emitSpy = vi.spyOn((bot as any).telemetrySink, 'emit');
      await bot.alarm();

      const alerts: TradeAlert[] = mockStorage.get("alerts") || [];
      expect(alerts).toHaveLength(0);
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'FINAL_DISPATCH_GATE',
          payload: expect.objectContaining({
            gate: 'MISSING_STRATEGY_RISK_DISTANCES',
            passed: false
          })
        })
      );
    });

    it("REG-02: Rejects signal with valid riskAssessment when explicit TP is infinite", async () => {
      mockExecuteCycle.mockResolvedValueOnce([{
        strategyId: 'ScalperV2',
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: {
            type: 'BUY',
            signalPrice: 50000.0,
            stopLoss: 49000.0,
            takeProfit: Infinity, // Explicit Infinity TP must be strictly rejected
            timeframe: '5m',
            riskAssessment: {
              stopLossDistance: 1000.0,
              takeProfitDistance: 2000.0
            }
          }
        }
      }]);

      const bot = new TradingBot(mockState, mockEnv);
      const emitSpy = vi.spyOn((bot as any).telemetrySink, 'emit');
      await bot.alarm();

      const alerts: TradeAlert[] = mockStorage.get("alerts") || [];
      expect(alerts).toHaveLength(0);
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'FINAL_DISPATCH_GATE',
          payload: expect.objectContaining({
            gate: 'MISSING_STRATEGY_RISK_DISTANCES',
            passed: false
          })
        })
      );
    });

    it("REG-03: Rejects signal when explicit SL or TP is zero or negative", async () => {
      const explicitZeroOrNegativeCases = [
        { sl: 0, tp: 52000.0 },
        { sl: -100.0, tp: 52000.0 },
        { sl: 49000.0, tp: 0 },
        { sl: 49000.0, tp: -50.0 },
      ];

      for (const tc of explicitZeroOrNegativeCases) {
        mockStorage.set("alerts", []);
        mockExecuteCycle.mockResolvedValueOnce([{
          strategyId: 'ScalperV2',
          confidenceScore: 90,
          hasSignal: true,
          metadata: {
            targetTimeframe: '5m',
            signal: {
              type: 'BUY',
              signalPrice: 50000.0,
              stopLoss: tc.sl,
              takeProfit: tc.tp,
              timeframe: '5m',
              riskAssessment: {
                stopLossDistance: 1000.0,
                takeProfitDistance: 2000.0
              }
            }
          }
        }]);

        const bot = new TradingBot(mockState, mockEnv);
        await bot.alarm();

        const alerts: TradeAlert[] = mockStorage.get("alerts") || [];
        expect(alerts).toHaveLength(0);
      }
    });

    it("REG-04: Rejects explicit wrong-side SL/TP despite valid riskAssessment distances", async () => {
      // Inverted BUY SL (51000 >= entry 50000) despite valid riskAssessment
      mockExecuteCycle.mockResolvedValueOnce([{
        strategyId: 'ScalperV2',
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: {
            type: 'BUY',
            signalPrice: 50000.0,
            stopLoss: 51000.0,
            takeProfit: 52000.0,
            timeframe: '5m',
            riskAssessment: {
              stopLossDistance: 1000.0,
              takeProfitDistance: 2000.0
            }
          }
        }
      }]);

      const bot = new TradingBot(mockState, mockEnv);
      const emitSpy = vi.spyOn((bot as any).telemetrySink, 'emit');
      await bot.alarm();

      const alerts: TradeAlert[] = mockStorage.get("alerts") || [];
      expect(alerts).toHaveLength(0);
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'FINAL_DISPATCH_GATE',
          payload: expect.objectContaining({
            gate: 'MISSING_STRATEGY_RISK_DISTANCES',
            passed: false
          })
        })
      );
    });

    it("REG-05: Genuinely absent explicit SL/TP with valid riskAssessment succeeds and uses ATR distances", async () => {
      mockFetchTicker.mockImplementation(() => Promise.resolve({ symbol: 'BTCUSDT', last: 50000.0 }));
      mockExecuteCycle.mockResolvedValueOnce([{
        strategyId: 'ScalperV2',
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: {
            type: 'BUY',
            signalPrice: 50000.0,
            stopLoss: null, // Genuinely absent
            takeProfit: null, // Genuinely absent
            timeframe: '5m',
            riskAssessment: {
              stopLossDistance: 1000.0,
              takeProfitDistance: 2000.0,
              riskRewardRatio: 2.0
            }
          }
        }
      }]);

      const bot = new TradingBot(mockState, mockEnv);
      await bot.alarm();

      const alerts: TradeAlert[] = mockStorage.get("alerts") || [];
      const alert = alerts.find(a => a.symbol === 'BTC/USDT');
      expect(alert).toBeDefined();
      expect(alert?.entryPrice).toBe(50000.0);
      expect(alert?.stopLoss).toBe(49000.0);
      expect(alert?.takeProfit).toBe(52000.0);
    });
  });

});
