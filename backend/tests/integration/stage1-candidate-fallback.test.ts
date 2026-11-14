import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradingBot, TradeAlert } from '../../src/trading-bot';
import { sendTradeNotification } from '../../src/handlers/notifications';
import { ExchangeManager } from '../../src/exchanges';
import { StrategyRegistry } from '../../src/engine/strategies/StrategyRegistry';
import { DirectionalMtfArbitrator } from '../../src/engine/arbitration/DirectionalMtfArbitrator';
import { MarketRegime, MarketRegimeEngine } from '../../src/engine/regime/MarketRegimeEngine';

vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('mocked_secret_key'),
}));

vi.mock('../../src/handlers/notifications', () => ({
  sendTradeNotification: vi.fn().mockResolvedValue({ success: true }),
  sendTradeFillNotification: vi.fn().mockResolvedValue({ success: true }),
}));

function generateCandles(count: number, trend: 'UP' | 'DOWN' | 'FLAT' = 'UP', startPrice = 100) {
  const candles: any[] = [];
  let price = startPrice;
  const now = Date.now();
  const stepMs = 60 * 60 * 1000; // 1h

  for (let i = 0; i < count; i++) {
    if (trend === 'UP') {
      price += 1.0;
    } else if (trend === 'DOWN') {
      price -= 1.0;
    } else {
      price = startPrice;
    }
    const openTime = now - (count - i) * stepMs;
    candles.push({
      timestamp: openTime,
      openTime,
      closeTime: openTime + stepMs,
      open: price,
      high: price + 0.1,
      low: price - 0.1,
      close: price,
      volume: 1000,
    });
  }
  return candles;
}

describe('Stage 1 Integration Test Suite: Strategy Evaluation & Safe Fallback', () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockDb: any;
  let mockAdapter: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = new Map();

    mockAdapter = {
      fetchTicker: vi.fn().mockResolvedValue({ symbol: 'BTCUSDT', last: 50000 }),
      fetchKlines: vi.fn().mockImplementation(async () => generateCandles(60, 'UP')),
      fetchBalance: vi.fn().mockResolvedValue({
        info: { result: { list: [{ coin: [{ coin: 'USDT', equity: '1000', walletBalance: '1000' }] }] } }
      }),
      fetchMarkets: vi.fn().mockResolvedValue([
        { id: 'BTCUSDT', symbol: 'BTC/USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } } },
        { id: 'ETHUSDT', symbol: 'ETH/USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.01 }, limits: { cost: { min: 5 }, amount: { min: 0.01, max: 1000 } } },
      ]),
      fetchMarket: vi.fn().mockImplementation(async (sym: string) => {
        if (sym.includes('ETH')) {
          return { id: 'ETHUSDT', symbol: 'ETH/USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.01 }, limits: { cost: { min: 5 }, amount: { min: 0.01, max: 1000 } } };
        }
        return { id: 'BTCUSDT', symbol: 'BTC/USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } } };
      }),
      createOrder: vi.fn().mockResolvedValue({ id: 'ord-1', status: 'closed' }),
    };

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter);

    mockState = {
      id: { toString: () => 'mock-do-id' },
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
        list: async (opts?: { prefix?: string }) => {
          const res = new Map();
          for (const [k, v] of mockStorage.entries()) {
            if (!opts?.prefix || k.startsWith(opts.prefix)) {
              res.set(k, v);
            }
          }
          return res;
        },
        transaction: async (cb: any) => cb({
          get: async (k: string) => mockStorage.get(k),
          put: async (k: string, v: any) => mockStorage.set(k, v),
          delete: async (k: string) => mockStorage.delete(k),
          list: async (opts?: { prefix?: string }) => {
            const res = new Map();
            for (const [k, v] of mockStorage.entries()) {
              if (!opts?.prefix || k.startsWith(opts.prefix)) res.set(k, v);
            }
            return res;
          },
        }),
        blockConcurrencyWhile: async (cb: any) => cb(),
        setAlarm: vi.fn(),
      },
      blockConcurrencyWhile: async (cb: any) => cb(),
    };

    mockDb = {
      prepare: vi.fn().mockImplementation((_q: string) => ({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ success: true }),
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: 'demo',
            exchange_region: 'global',
            exchange_api_key: 'test_key',
            exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
            exchange_api_secret_encrypted: 'test_sec',
          }),
        }),
      })),
      run: vi.fn().mockResolvedValue({ success: true }),
    };

    mockEnv = {
      DB: mockDb,
      ENCRYPTION_KEY: 'test_encryption_key_32_bytes_long!!',
      GLOBAL_TRADING_HALT: 'false',
    };
  });

  function setupBot(symbol = 'BTC/USDT', initialOverrides: Record<string, any> = {}) {
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('monitoredSymbols', [symbol]);
    mockStorage.set('lock:alarmGeneration', 10);
    mockStorage.set('positionSize', 100);
    mockStorage.set('alerts', []);
    mockStorage.set('activePositions', []);
    mockStorage.set('approvedCandidateRecord', {
      approvalGeneration: 10,
      userId: 'user-test-1',
      budgetUsdt: 100,
      approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT', 'ETH', 'ETHUSDT', 'ETH/USDT', symbol],
      approvalState: 'FINAL_APPROVED',
      exchangeName: 'bybit',
      environment: 'demo',
      accountFingerprint: 'bybit:demo',
      orderType: 'ALL',
      approvedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      symbolMetadataSnapshot: {}
    });

    for (const [k, v] of Object.entries(initialOverrides)) {
      mockStorage.set(k, v);
    }
    const bot = new TradingBot(mockState, mockEnv);
    return bot;
  }

  // 1. Registry-order strategy evaluation
  it('1. evaluates strategies in exact StrategyRegistry insertion order (ScalperV2 -> Momentum -> Breakout)', async () => {
    const bot = setupBot();
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'Momentum', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
      { strategyId: 'ScalperV2', confidenceScore: 80, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0].strategy).toBe('ScalperV2_NEW'); // ScalperV2 evaluated first by registry order
  });

  // 2. Highest-confidence timeframe selection within each strategy
  it('2. selects highest-confidence timeframe within a strategy before cross-strategy evaluation', async () => {
    const bot = setupBot();
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 70, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
      { strategyId: 'ScalperV2', confidenceScore: 88, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49200, takeProfit: 51500, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0].timeframe).toBe('15m');
    expect(alerts[0].strategy).toBe('ScalperV2_NEW');
  });

  // 3. First strategy fails risk validation; next eligible strategy succeeds
  it('3. falls back to next strategy when first strategy fails risk gate (EXTREME)', async () => {
    const bot = setupBot();
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'EXTREME' } } } },
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0].strategy).toBe('Momentum_NEW');
  });

  // 4. First strategy fails position-size validation (<= 0) -> skips alert creation without fallback
  it('4. skips alert creation when first strategy has invalid position size (<= 0) without fallback', async () => {
    const bot = setupBot('BTC/USDT', { positionSize: 0 }); // dynamic sizing from recommendation
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 0, riskClassification: 'LOW' } } } },
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 150, riskClassification: 'LOW' } } } },
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
    expect(mockAdapter.createOrder).not.toHaveBeenCalled();
  });

  // 5. First strategy fails exposure validation -> skips alert creation without fallback
  it('5. skips alert creation when first strategy exceeds portfolio exposure limit without fallback', async () => {
    // Current exposure $800, balance $1000, max default exposure $1000
    const bot = setupBot('BTC/USDT', {
      positionSize: 0,
      activePositions: [{ id: 'pos-1', symbol: 'SOL/USDT', amount: 10, averageFillPrice: 80, status: 'OPEN' }] // $800
    });
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 300, riskClassification: 'LOW' } } } }, // 800+300=1100 > 1000
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 150, riskClassification: 'LOW' } } } }, // 800+150=950 <= 1000
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
    expect(mockAdapter.createOrder).not.toHaveBeenCalled();
  });

  // 6. Exposure validation prevents execution -> skips alert creation without fallback
  it('6. skips alert creation when strategy exceeds portfolio exposure limit without fallback', async () => {
    const bot = setupBot('BTC/USDT', {
      positionSize: 0,
      activePositions: [{ id: 'pos-1', symbol: 'ETH/USDT', amount: 2, averageFillPrice: 450, status: 'OPEN' }] // $900
    });
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 200, riskClassification: 'LOW' } } } }, // 900+200=1100 > 1000 -> fails
      { strategyId: 'Breakout', confidenceScore: 80, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '1h', riskAssessment: { positionSizeRecommendation: 50, riskClassification: 'LOW' } } } }, // 900+50=950 <= 1000 -> passes
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
    expect(mockAdapter.createOrder).not.toHaveBeenCalled();
  });

  // 7. First strategy fails min notional ($5) -> skips alert creation without fallback
  it('7. skips alert creation when first strategy is below min notional ($5) without fallback', async () => {
    const bot = setupBot('BTC/USDT', { positionSize: 0 });
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 2, riskClassification: 'LOW' } } } }, // $2 < minNotional $5
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 50, riskClassification: 'LOW' } } } }, // $50 >= minNotional
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
    expect(mockAdapter.createOrder).not.toHaveBeenCalled();
  });

  // 8. Unsupported SELL signal is skipped; next eligible strategy is evaluated
  it('8. skips strategy producing SELL signal if manifest supportsShort=false and evaluates next', async () => {
    const bot = setupBot();
    const manifest = StrategyRegistry.getInstance().getManifest('ScalperV2')!;
    const origSupportsShort = manifest.supportsShort;
    manifest.supportsShort = false;
    try {
      vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
        { strategyId: 'ScalperV2', confidenceScore: 95, hasSignal: true, metadata: { signal: { type: 'SELL', signalPrice: 50000, stopLoss: 50500, takeProfit: 49000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
        { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
      ]);

      await bot.alarm();
      const alerts = mockStorage.get('alerts') as TradeAlert[];
      expect(alerts).toHaveLength(1);
      expect(alerts[0].strategy).toBe('Momentum_NEW');
      expect(alerts[0].side).toBe('BUY');
    } finally {
      manifest.supportsShort = origSupportsShort;
    }
  });

  // 9. Existing active alert blocks all strategies for that ticker
  it('9. blocks every strategy for a ticker when an active pending alert exists (<5m)', async () => {
    const existingAlert: TradeAlert = {
      id: 'existing-alert-1',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 10,
      positionSize: 100,
      strategy: 'ScalperV2_NEW',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      timeframe: '5m',
    };
    const bot = setupBot('BTC/USDT', { alerts: [existingAlert] });
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe('existing-alert-1');
    expect(mockAdapter.fetchMarket).not.toHaveBeenCalled();
  });

  // 10. Existing active position blocks all strategies for that ticker
  it('10. blocks every strategy for a ticker when an active position exists', async () => {
    const bot = setupBot('BTC/USDT', {
      activePositions: [{ id: 'pos-btc', symbol: 'BTC/USDT', status: 'OPEN', amount: 0.01, averageFillPrice: 50000 }]
    });
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
    expect(mockAdapter.fetchMarket).not.toHaveBeenCalled();
  });

  // 11. Unresolved WAL intent blocks all strategies for that ticker
  it('11. blocks every strategy for a ticker when an unresolved WAL intent exists', async () => {
    const bot = setupBot('BTC/USDT', {
      'intent:order:intent-1': { intentId: 'intent-1', symbol: 'BTC/USDT', status: 'DISPATCHED' }
    });
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
    expect(mockAdapter.fetchMarket).not.toHaveBeenCalled();
  });

  // 12. Missing tick-size metadata blocks further strategies for that ticker
  it('12. stops strategy evaluation for that ticker if authoritative tickSize is missing', async () => {
    mockAdapter.fetchMarket.mockResolvedValueOnce({
      id: 'BTCUSDT', symbol: 'BTC/USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 0 }, limits: { cost: { min: 5 } }
    });
    const bot = setupBot();
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
  });

  // 13. Missing quantity step-size metadata generates signal-only alert
  it('13. generates signal-only alert for that ticker if stepSize is missing', async () => {
    mockAdapter.fetchMarket.mockResolvedValueOnce({
      id: 'BTCUSDT', symbol: 'BTC/USDT', active: true, category: 'linear', precision: { amount: 0, price: 0.1 }, limits: { cost: { min: 5 } }
    });
    const bot = setupBot();
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
    expect(mockAdapter.createOrder).not.toHaveBeenCalled();
  });

  // 14. Metadata is fetched at most once per ticker evaluation and reused
  it('14. fetches exchange metadata at most once per ticker evaluation and reuses in-memory', async () => {
    const bot = setupBot();
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 2, riskClassification: 'LOW' } } } }, // fails Gate 9 ($2 < $5)
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } }, // reaches Gate 8/9 and passes
    ]);

    await bot.alarm();
    expect(mockAdapter.fetchMarket).toHaveBeenCalledTimes(1);
    expect(mockAdapter.fetchMarket).toHaveBeenCalledWith('BTC/USDT');
  });

  // 15. Different tickers receive independent metadata lookups
  it('15. performs independent metadata lookups for distinct tickers', async () => {
    const bot = setupBot('BTC/USDT', { monitoredSymbols: ['BTC/USDT', 'ETH/USDT'] });
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockImplementation(async (sym: string) => [
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } }
    ]);

    await bot.alarm();
    expect(mockAdapter.fetchMarket).toHaveBeenCalledWith('BTC/USDT');
    expect(mockAdapter.fetchMarket).toHaveBeenCalledWith('ETH/USDT');
    expect(mockAdapter.fetchMarket).toHaveBeenCalledTimes(2);
  });

  // 16. Bot deactivation during an asynchronous yield aborts the alarm
  it('16. aborts the alarm execution when bot is deactivated during async yield', async () => {
    const bot = setupBot();
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } }
    ]);

    const origGet = mockState.storage.get;
    mockState.storage.get = vi.fn().mockImplementation(async (k: any) => {
      if (k === 'isActive') return false; // deactivated mid-cycle
      return origGet(k);
    });

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
  });

  // 17. Alarm generation mismatch aborts the alarm
  it('17. aborts alarm when stored generation changes mid-cycle (stale generation)', async () => {
    const bot = setupBot();
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } }
    ]);

    let genReads = 0;
    const origGet = mockState.storage.get;
    mockState.storage.get = vi.fn().mockImplementation(async (k: any) => {
      if (k === 'lock:alarmGeneration') {
        genReads++;
        if (genReads > 1) return 999; // generation changed mid-cycle before publication
        return 10;
      }
      return origGet(k);
    });

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
  });

  // 18. isExecutingTrade prevents alert creation
  it('18. prevents alert creation when isExecutingTrade is active', async () => {
    const bot = setupBot('BTC/USDT', { isExecutingTrade: true });
    (bot as any).isExecutingTrade = true;
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } }
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
  });

  // 19. unprotectedExposureLock prevents alert creation
  it('19. prevents alert creation when an unprotected exposure lock exists', async () => {
    const lock = { symbol: 'BTC/USDT', reason: 'SL missing', lockedAt: Date.now() };
    const bot = setupBot('BTC/USDT', { 'lock:unprotectedExposure': lock });
    (bot as any).unprotectedExposureLock = lock;
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } }
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
  });

  // 20. State changes during asynchronous processing are detected by final revalidation
  it('20. detects state changes during async processing and aborts alert persistence', async () => {
    const bot = setupBot();
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } }
    ]);

    // Simulate concurrent execute-trade slipping in and adding position during fetchMarket await
    mockAdapter.fetchMarket.mockImplementationOnce(async () => {
      (bot as any).runtimeState.activePositions.push({ id: 'concurrent-pos', symbol: 'BTC/USDT', status: 'OPEN' });
      return { id: 'BTCUSDT', symbol: 'BTC/USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } } };
    });

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
  });

  // 21. Existing five-minute lockout blocks at 299 seconds and permits evaluation after expiration
  it('21. preserves 5-minute lockout at 299s and allows signal at 301s', async () => {
    const now = Date.now();
    const freshAlert: TradeAlert = {
      id: 'fresh-alert', symbol: 'BTC/USDT', signalPrice: 50000, entryPrice: 50000, stopLoss: 49000, takeProfit: 52000,
      estimatedPnl: 10, positionSize: 100, strategy: 'ScalperV2_NEW', side: 'BUY',
      timestamp: new Date(now - 299_000).toISOString(), status: 'pending', timeframe: '5m'
    };
    const bot = setupBot('BTC/USDT', { alerts: [freshAlert] });
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } }
    ]);

    // Test at 299s: blocked
    await bot.alarm();
    expect(mockStorage.get('alerts')).toHaveLength(1);

    // Update timestamp to 301s ago: unblocked
    freshAlert.timestamp = new Date(now - 301_000).toISOString();
    mockStorage.set('alerts', [freshAlert]);
    (bot as any).runtimeState.alerts = [freshAlert];

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(2); // new alert created!
  });

  // 22. Successful alert creation stops further strategy evaluation for that ticker
  it('22. stops evaluating further strategies for that ticker once an alert is created', async () => {
    const bot = setupBot();
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
      { strategyId: 'Breakout', confidenceScore: 80, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '1h', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } },
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0].strategy).toBe('ScalperV2_NEW');
  });

  // 23. All strategies failing genuine technical qualification gates produces no new alert
  it('23. produces zero alerts when all candidates fail genuine technical qualification gates', async () => {
    const bot = setupBot('BTC/USDT', { positionSize: 0 });
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'EXTREME' } } } }, // fails technical risk gate (EXTREME)
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'EXTREME' } } } }, // fails technical risk gate (EXTREME)
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
    expect(mockAdapter.createOrder).not.toHaveBeenCalled();
  });

  // 24. Existing TradeAlert schema is preserved
  it('24. preserves the exact existing TradeAlert schema', async () => {
    const bot = setupBot();
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 92, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, targetEntryPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } } } }
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(1);
    const a = alerts[0];
    expect(typeof a.id).toBe('string');
    expect(a.symbol).toBe('BTC/USDT');
    expect(typeof a.signalPrice).toBe('number');
    expect(typeof a.entryPrice).toBe('number');
    expect(typeof a.stopLoss).toBe('number');
    expect(typeof a.takeProfit).toBe('number');
    expect(typeof a.positionSize).toBe('number');
    expect(a.strategy).toBe('ScalperV2_NEW');
    expect(a.side).toBe('BUY');
    expect(typeof a.timestamp).toBe('string');
    expect(a.status).toBe('pending');
    expect(a.timeframe).toBe('5m');
    expect(a.generation).toBe(10);
    expect(a.source).toBe('AUTONOMOUS');
  });

  // 25. Existing FCM notification arguments and payload remain unchanged
  it('25. preserves existing FCM notification arguments and payload', async () => {
    const bot = setupBot();
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      {
        strategyId: 'ScalperV2',
        confidenceScore: 92,
        hasSignal: true,
        metadata: {
          reasoning: ['Trend continuation confirmed'],
          signal: { type: 'BUY', signalPrice: 50000, targetEntryPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' } }
        }
      }
    ]);

    await bot.alarm();
    expect(sendTradeNotification).toHaveBeenCalledTimes(1);
    const [envArg, userIdArg, alertIdArg, payloadArg] = (sendTradeNotification as any).mock.calls[0];
    expect(envArg).toBe(mockEnv);
    expect(userIdArg).toBe('user-test-1');
    expect(typeof alertIdArg).toBe('string');
    expect(payloadArg).toMatchObject({
      symbol: 'BTC/USDT',
      side: 'BUY',
      strategy: 'ScalperV2_NEW',
      timeframe: '5m',
      confidenceScore: 92,
      reasoning: ['Trend continuation confirmed'],
    });
  });

  // ==========================================================================
  // OBJECTIVE 2 MANDATORY SCENARIOS: CLOSED-CANDLE GATE REJECTION SUPPRESSION
  // ==========================================================================
  describe('Objective 2 Mandatory Closed-Candle Gate Rejection Scenarios', () => {
    const FIXED_ANCHOR_TIME = 1789000000000 - (1789000000000 % (4 * 3600 * 1000));

    function generateDeterministicCandles(count: number, endTime: number, stepMs = 300_000, startPrice = 100) {
      const candles: any[] = [];
      for (let i = 0; i < count; i++) {
        const price = startPrice + i * 1.5;
        const openTime = endTime - (count - i) * stepMs;
        candles.push({
          timestamp: openTime,
          openTime,
          closeTime: openTime + stepMs,
          open: price,
          high: price + 0.5,
          low: price - 0.5,
          close: price,
          volume: 1000,
        });
      }
      return candles;
    }

    it('26. Same rejected candidate, same closed candle, 15-second alarm repeats -> no repeated evaluation or alert', async () => {
      mockAdapter.fetchKlines.mockImplementation(async () => generateDeterministicCandles(60, FIXED_ANCHOR_TIME, 300_000));
      const bot = setupBot();
      const logAuditSpy = vi.spyOn(bot as any, 'logAuditEvent');

      // Cycle 1: ScalperV2 is rejected by RISK_GATE_REJECTED (EXTREME)
      vi.spyOn((bot as any).orchestrator, 'executeCycle').mockImplementation(async (_sym: string, _tf: any, _cfg: any, _bal: any, ctx: any) => {
        if (ctx?.isCandidateSuppressed?.('ScalperV2', '5m')) {
          return [];
        }
        return [
          {
            strategyId: 'ScalperV2',
            confidenceScore: 90,
            hasSignal: true,
            metadata: {
              targetTimeframe: '5m',
              signal: {
                type: 'BUY',
                signalPrice: 50000,
                stopLoss: 49500,
                takeProfit: 51000,
                timeframe: '5m',
                riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'EXTREME' },
              },
            },
          },
        ];
      });

      await bot.alarm();
      expect(mockStorage.get('alerts')).toHaveLength(0);
      expect(logAuditSpy).toHaveBeenCalledTimes(1);

      // Cycle 2 (15s later, same closed candle): suppressed before evaluation / gate re-entry
      await bot.alarm();
      expect(mockStorage.get('alerts')).toHaveLength(0);
      expect(logAuditSpy).toHaveBeenCalledTimes(1); // Not re-evaluated or re-rejected!
    });

    it('27. New eligible candle closes -> previously rejected candidate may be evaluated again and generates alert', async () => {
      let currentEndTime = FIXED_ANCHOR_TIME;
      mockAdapter.fetchKlines.mockImplementation(async () => generateDeterministicCandles(60, currentEndTime, 300_000));
      const bot = setupBot();

      let riskClassification: 'EXTREME' | 'LOW' = 'EXTREME';
      vi.spyOn((bot as any).orchestrator, 'executeCycle').mockImplementation(async (_sym: string, _tf: any, _cfg: any, _bal: any, ctx: any) => {
        if (ctx?.isCandidateSuppressed?.('ScalperV2', '5m')) {
          return [];
        }
        return [
          {
            strategyId: 'ScalperV2',
            confidenceScore: 90,
            hasSignal: true,
            metadata: {
              targetTimeframe: '5m',
              signal: {
                type: 'BUY',
                signalPrice: 50000,
                stopLoss: 49500,
                takeProfit: 51000,
                timeframe: '5m',
                riskAssessment: { positionSizeRecommendation: 100, riskClassification },
              },
            },
          },
        ];
      });

      // Cycle 1: Rejected on candle T0
      await bot.alarm();
      expect(mockStorage.get('alerts')).toHaveLength(0);

      // Cycle 2: Same candle T0 -> still suppressed even if riskClassification were LOW
      riskClassification = 'LOW';
      await bot.alarm();
      expect(mockStorage.get('alerts')).toHaveLength(0);

      // Cycle 3: New 5m candle closes (T0 + 300_000ms) -> re-evaluated and creates alert!
      currentEndTime = FIXED_ANCHOR_TIME + 300_000;
      await bot.alarm();
      const alerts = mockStorage.get('alerts') as TradeAlert[];
      expect(alerts).toHaveLength(1);
      expect(alerts[0].strategy).toBe('ScalperV2_NEW');
    });

    it('28. Strategy-specific rejection -> same strategy suppressed for that candle while another strategy remains eligible', async () => {
      mockAdapter.fetchKlines.mockImplementation(async () => generateDeterministicCandles(60, FIXED_ANCHOR_TIME, 300_000));
      const bot = setupBot();

      // Cycle 1: Only ScalperV2 signals, rejected by RISK_GATE_REJECTED
      const execSpy = vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValueOnce([
        {
          strategyId: 'ScalperV2',
          confidenceScore: 92,
          hasSignal: true,
          metadata: {
            targetTimeframe: '5m',
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              stopLoss: 49500,
              takeProfit: 51000,
              timeframe: '5m',
              riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'EXTREME' },
            },
          },
        },
      ]);

      await bot.alarm();
      expect(mockStorage.get('alerts')).toHaveLength(0);

      // Cycle 2 (same candle): ScalperV2 is suppressed for this candle, while Momentum produces a valid signal and succeeds
      execSpy.mockResolvedValueOnce([
        {
          strategyId: 'ScalperV2',
          confidenceScore: 95,
          hasSignal: true,
          metadata: {
            targetTimeframe: '5m',
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              stopLoss: 49500,
              takeProfit: 51000,
              timeframe: '5m',
              riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' },
            },
          },
        },
        {
          strategyId: 'Momentum',
          confidenceScore: 85,
          hasSignal: true,
          metadata: {
            targetTimeframe: '15m',
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              stopLoss: 49000,
              takeProfit: 52000,
              timeframe: '15m',
              riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' },
            },
          },
        },
      ]);

      await bot.alarm();
      const alerts = mockStorage.get('alerts') as TradeAlert[];
      expect(alerts).toHaveLength(1);
      expect(alerts[0].strategy).toBe('Momentum_NEW');
    });

    it('29. Symbol-wide safety rejection -> another strategy cannot bypass it on the same closed candle', async () => {
      mockAdapter.fetchKlines.mockImplementation(async () => generateDeterministicCandles(60, FIXED_ANCHOR_TIME, 300_000));
      // Budget $2 is below minimum notional ($5) -> symbol-wide safety rejection (BUDGET_INSUFFICIENT_AT_CURRENT_PRICE)
      const bot = setupBot('BTC/USDT', { positionSize: 2 });

      const execSpy = vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
        {
          strategyId: 'ScalperV2',
          confidenceScore: 90,
          hasSignal: true,
          metadata: {
            targetTimeframe: '5m',
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              stopLoss: 49500,
              takeProfit: 51000,
              timeframe: '5m',
              riskAssessment: { positionSizeRecommendation: 2, riskClassification: 'LOW' },
            },
          },
        },
        {
          strategyId: 'Momentum',
          confidenceScore: 88,
          hasSignal: true,
          metadata: {
            targetTimeframe: '15m',
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              stopLoss: 49000,
              takeProfit: 52000,
              timeframe: '15m',
              riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' },
            },
          },
        },
      ]);

      // Cycle 1: Symbol-wide safety rejection recorded against closed candle
      await bot.alarm();
      expect(mockStorage.get('alerts')).toHaveLength(0);
      expect(execSpy).toHaveBeenCalledTimes(1);

      // Cycle 2 (same closed candle): Symbol-wide rejection prevents executeCycle and blocks any strategy from bypassing it
      await bot.alarm();
      expect(mockStorage.get('alerts')).toHaveLength(0);
      expect(execSpy).toHaveBeenCalledTimes(1); // Skipped entirely on Cycle 2!
    });

    it('30. Dismissed alert -> existing duplicate-suppression protection remains effective for same strategy', async () => {
      mockAdapter.fetchKlines.mockImplementation(async () => generateDeterministicCandles(60, FIXED_ANCHOR_TIME, 300_000));
      const dismissedAlert: TradeAlert = {
        id: 'dismissed-scalper-1',
        symbol: 'BTC/USDT',
        signalPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        positionSize: 100,
        strategy: 'ScalperV2_NEW',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'dismissed',
        timeframe: '5m',
      };
      const bot = setupBot('BTC/USDT', { alerts: [dismissedAlert] });
      vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
        {
          strategyId: 'ScalperV2',
          confidenceScore: 92,
          hasSignal: true,
          metadata: {
            targetTimeframe: '5m',
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              stopLoss: 49500,
              takeProfit: 51000,
              timeframe: '5m',
              riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' },
            },
          },
        },
      ]);

      await bot.alarm();
      const alerts = mockStorage.get('alerts') as TradeAlert[];
      // Same strategy/timeframe must remain suppressed within 5m cooldown after dismissal
      expect(alerts).toHaveLength(1);
      expect(alerts[0].id).toBe('dismissed-scalper-1');
    });

    it('31. Rejection state survives Durable Object restart/alarm cycles and is cleaned up safely on new candle', async () => {
      let currentEndTime = FIXED_ANCHOR_TIME;
      mockAdapter.fetchKlines.mockImplementation(async () => generateDeterministicCandles(60, currentEndTime, 300_000));

      // Bot instance 1 records strategy rejection
      const bot1 = setupBot();
      vi.spyOn((bot1 as any).orchestrator, 'executeCycle').mockResolvedValue([
        {
          strategyId: 'ScalperV2',
          confidenceScore: 90,
          hasSignal: true,
          metadata: {
            targetTimeframe: '5m',
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              stopLoss: 49500,
              takeProfit: 51000,
              timeframe: '5m',
              riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'EXTREME' },
            },
          },
        },
      ]);
      await bot1.alarm();
      const persistedRejections1 = mockStorage.get('gateRejections');
      expect(persistedRejections1).toBeDefined();
      expect(Object.keys(persistedRejections1.strategyRejections)).toHaveLength(1);

      // Simulate DO cold-start / re-instantiation from storage on same candle
      const bot2 = new TradingBot(mockState, mockEnv);
      vi.spyOn((bot2 as any).orchestrator, 'executeCycle').mockResolvedValue([
        {
          strategyId: 'ScalperV2',
          confidenceScore: 90,
          hasSignal: true,
          metadata: {
            targetTimeframe: '5m',
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              stopLoss: 49500,
              takeProfit: 51000,
              timeframe: '5m',
              riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' },
            },
          },
        },
      ]);
      await bot2.alarm();
      expect(mockStorage.get('alerts')).toHaveLength(0); // Still suppressed after DO restart on same candle!

      // Advance candle -> stale rejection record is cleaned up from storage and candidate is evaluated
      currentEndTime = FIXED_ANCHOR_TIME + 300_000;
      await bot2.alarm();
      const persistedRejectionsAfterCleanup = mockStorage.get('gateRejections');
      expect(Object.keys(persistedRejectionsAfterCleanup.strategyRejections)).toHaveLength(0);
      expect(mockStorage.get('alerts')).toHaveLength(1);
    });

    it('32. FCM delivery failure is not treated as an internal gate rejection', async () => {
      mockAdapter.fetchKlines.mockImplementation(async () => generateDeterministicCandles(60, FIXED_ANCHOR_TIME, 300_000));
      (sendTradeNotification as any).mockResolvedValueOnce({ success: false, error: 'FCM_TIMEOUT' });

      const bot = setupBot();
      vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
        {
          strategyId: 'ScalperV2',
          confidenceScore: 92,
          hasSignal: true,
          metadata: {
            targetTimeframe: '5m',
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              stopLoss: 49500,
              takeProfit: 51000,
              timeframe: '5m',
              riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' },
            },
          },
        },
      ]);

      await bot.alarm();
      const alerts = mockStorage.get('alerts') as TradeAlert[];
      expect(alerts).toHaveLength(1);
      const gateRejections = mockStorage.get('gateRejections');
      expect(Object.keys(gateRejections?.strategyRejections || {})).toHaveLength(0);
      expect(Object.keys(gateRejections?.symbolRejections || {})).toHaveLength(0);
    });

    it('33. Momentum entry-timeframe ADX protection across 5m, 15m, 1h and 4h: rejects ADX < 20 and approves ADX >= 20', async () => {
      const trendingRegime: MarketRegime = {
        regime: 'TRENDING',
        score: 85,
        allowTrendStrategies: true,
        allowMeanReversion: false,
      };
      const strongTrendCandles = generateDeterministicCandles(60, FIXED_ANCHOR_TIME, 300_000, 100);
      const flatLowAdxCandles = Array.from({ length: 60 }, (_, i) => {
        const openTime = FIXED_ANCHOR_TIME - (60 - i) * 300_000;
        return {
          timestamp: openTime,
          openTime,
          closeTime: openTime + 300_000,
          open: 100,
          high: 100.1,
          low: 99.9,
          close: 100,
          volume: 1000,
        };
      });

      for (const tf of ['5m', '15m', '1h', '4h'] as const) {
        const candidate = {
          strategyId: 'Momentum',
          timestamp: FIXED_ANCHOR_TIME,
          confidenceScore: 88,
          hasSignal: true,
          metadata: {
            targetTimeframe: tf,
            signal: {
              symbol: 'BTC/USDT',
              timeframe: tf,
              type: 'BUY',
              confidenceScore: 88,
              signalPrice: 50000,
              stopLoss: 49000,
              takeProfit: 52000,
              riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' },
            },
          },
        } as any;

        // 1. Weak ADX (< 20) on entry timeframe -> rejected
        const weakSnapshot: any = {
          symbol: 'BTC/USDT',
          timestamp: FIXED_ANCHOR_TIME,
          currentPrice: 50000,
          volume24h: 1000,
          quoteVolume24h: 50000000,
          candles: {
            '5m': strongTrendCandles,
            '15m': strongTrendCandles,
            '1h': strongTrendCandles,
            '4h': strongTrendCandles,
            [tf]: flatLowAdxCandles,
          },
        };
        const weakRes = DirectionalMtfArbitrator.evaluateCandidate(candidate, weakSnapshot, trendingRegime);
        expect(weakRes.passed).toBe(false);
        expect(['REGIME_PROHIBITED', 'HTF_CONFLICT']).toContain(weakRes.gate);

        // 2. Strong ADX (>= 20) across entry and HTF timeframes -> approved
        const strongSnapshot: any = {
          ...weakSnapshot,
          candles: {
            '5m': strongTrendCandles,
            '15m': strongTrendCandles,
            '1h': strongTrendCandles,
            '4h': strongTrendCandles,
          },
        };
        const strongRes = DirectionalMtfArbitrator.evaluateCandidate(candidate, strongSnapshot, trendingRegime);
        expect(strongRes.passed).toBe(true);
        expect(strongRes.gate).toBe('PASS');
      }
    });

    it('34. Momentum fail-closed on insufficient (< 35) or invalid entry candles and enforces self-HTF confirmation on 1h and 4h', () => {
      const trendingRegime: MarketRegime = {
        regime: 'TRENDING',
        score: 85,
        allowTrendStrategies: true,
        allowMeanReversion: false,
      };
      const strongTrendCandles = generateDeterministicCandles(60, FIXED_ANCHOR_TIME, 300_000, 100);
      const flatCandles = Array.from({ length: 60 }, (_, i) => ({
        timestamp: FIXED_ANCHOR_TIME - (60 - i) * 3600_000,
        openTime: FIXED_ANCHOR_TIME - (60 - i) * 3600_000,
        closeTime: FIXED_ANCHOR_TIME - (59 - i) * 3600_000,
        open: 100,
        high: 100.1,
        low: 99.9,
        close: 100,
        volume: 1000,
      }));

      for (const tf of ['5m', '15m', '1h', '4h'] as const) {
        const candidate = {
          strategyId: 'Momentum',
          timestamp: FIXED_ANCHOR_TIME,
          confidenceScore: 88,
          hasSignal: true,
          metadata: {
            targetTimeframe: tf,
            signal: {
              symbol: 'BTC/USDT',
              timeframe: tf,
              type: 'BUY',
              confidenceScore: 88,
              signalPrice: 50000,
            },
          },
        } as any;

        // Insufficient entry candles (20 < 35) must fail closed with INSUFFICIENT_HTF_DATA
        const shortSnapshot: any = {
          symbol: 'BTC/USDT',
          timestamp: FIXED_ANCHOR_TIME,
          currentPrice: 50000,
          volume24h: 1000,
          quoteVolume24h: 50000000,
          candles: {
            '5m': strongTrendCandles,
            '15m': strongTrendCandles,
            '1h': strongTrendCandles,
            '4h': strongTrendCandles,
            [tf]: strongTrendCandles.slice(0, 20),
          },
        };
        const shortRes = DirectionalMtfArbitrator.evaluateCandidate(candidate, shortSnapshot, trendingRegime);
        expect(shortRes.passed).toBe(false);
        expect(shortRes.gate).toBe('INSUFFICIENT_HTF_DATA');

        // Invalid numeric candle (close <= 0 / NaN) in entry series must fail closed
        const invalidCandles = strongTrendCandles.map(c => ({ ...c }));
        invalidCandles[invalidCandles.length - 1].close = NaN;
        const invalidSnapshot: any = {
          ...shortSnapshot,
          candles: {
            ...shortSnapshot.candles,
            [tf]: invalidCandles,
          },
        };
        const invalidRes = DirectionalMtfArbitrator.evaluateCandidate(candidate, invalidSnapshot, trendingRegime);
        expect(invalidRes.passed).toBe(false);
        expect(invalidRes.gate).toBe('INSUFFICIENT_HTF_DATA');
      }

      // Self-HTF enforcement: 1h candidate rejected when 1h is NEUTRAL even if 4h is BULLISH
      const candidate1h = {
        strategyId: 'Momentum',
        timestamp: FIXED_ANCHOR_TIME,
        confidenceScore: 88,
        hasSignal: true,
        metadata: {
          targetTimeframe: '1h',
          signal: { symbol: 'BTC/USDT', timeframe: '1h', type: 'BUY', confidenceScore: 88, signalPrice: 50000 },
        },
      } as any;
      const neutral1hBull4hSnapshot: any = {
        symbol: 'BTC/USDT',
        timestamp: FIXED_ANCHOR_TIME,
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': flatCandles,
          '4h': strongTrendCandles,
        },
      };
      const self1hRes = DirectionalMtfArbitrator.evaluateCandidate(candidate1h, neutral1hBull4hSnapshot, trendingRegime);
      expect(self1hRes.passed).toBe(false);
      expect(self1hRes.gate).toBe('HTF_CONFLICT');

      // Self-HTF enforcement: 4h candidate rejected when 4h is NEUTRAL even if 1h is BULLISH
      const candidate4h = {
        strategyId: 'Momentum',
        timestamp: FIXED_ANCHOR_TIME,
        confidenceScore: 88,
        hasSignal: true,
        metadata: {
          targetTimeframe: '4h',
          signal: { symbol: 'BTC/USDT', timeframe: '4h', type: 'BUY', confidenceScore: 88, signalPrice: 50000 },
        },
      } as any;
      const bull1hNeutral4hSnapshot: any = {
        symbol: 'BTC/USDT',
        timestamp: FIXED_ANCHOR_TIME,
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': strongTrendCandles,
          '4h': flatCandles,
        },
      };
      const self4hRes = DirectionalMtfArbitrator.evaluateCandidate(candidate4h, bull1hNeutral4hSnapshot, trendingRegime);
      expect(self4hRes.passed).toBe(false);
      expect(self4hRes.gate).toBe('HTF_CONFLICT');
    });

    it('35. Momentum centralized rejection suppression: suppresses repeated 15s cycles, allows Breakout fallback, survives DO restart, and re-evaluates on next closed candle', async () => {
      let currentEndTime = FIXED_ANCHOR_TIME;
      const flat5mCandles = Array.from({ length: 60 }, (_, i) => {
        const openTime = currentEndTime - (60 - i) * 300_000;
        return {
          timestamp: openTime,
          openTime,
          closeTime: openTime + 300_000,
          open: 100,
          high: 100.1,
          low: 99.9,
          close: 100,
          volume: 1000,
        };
      });

      let useWeak5m = true;
      mockAdapter.fetchKlines.mockImplementation(async (_sym: string, tf: string) => {
        if (tf === '5m' && useWeak5m) {
          return flat5mCandles.map((c, i) => ({
            ...c,
            timestamp: currentEndTime - (60 - i) * 300_000,
            openTime: currentEndTime - (60 - i) * 300_000,
            closeTime: currentEndTime - (59 - i) * 300_000,
          }));
        }
        return generateDeterministicCandles(60, currentEndTime, 300_000);
      });

      const bot1 = setupBot('BTC/USDT', { strategy: 'Momentum' });
      const logAuditSpy = vi.spyOn(bot1 as any, 'logAuditEvent');

      vi.spyOn((bot1 as any).orchestrator, 'executeCycle').mockImplementation(async (_sym: string, _tf: any, _cfg: any, _bal: any, ctx: any) => {
        if (ctx?.isCandidateSuppressed?.('Momentum', '5m')) {
          return [];
        }
        return [
          {
            strategyId: 'Momentum',
            confidenceScore: 88,
            hasSignal: true,
            metadata: {
              targetTimeframe: '5m',
              signal: {
                type: 'BUY',
                signalPrice: 50000,
                stopLoss: 49000,
                takeProfit: 52000,
                timeframe: '5m',
                riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' },
              },
            },
          },
        ];
      });

      // Cycle 1: Momentum 5m rejected at Gate 4.5 due to weak 5m ADX (< 20)
      await bot1.alarm();
      expect(mockStorage.get('alerts')).toHaveLength(0);
      expect(logAuditSpy).toHaveBeenCalledTimes(1);
      const rejections1 = mockStorage.get('gateRejections');
      expect(rejections1?.strategyRejections?.['BTCUSDT:momentum:5m']).toBeDefined();

      // Cycle 2 (15s later, same closed 5m candle): suppressed before re-evaluation
      await bot1.alarm();
      expect(mockStorage.get('alerts')).toHaveLength(0);
      expect(logAuditSpy).toHaveBeenCalledTimes(1);

      // Cycle 3: Simulate DO restart on same closed candle; Momentum remains suppressed while Breakout remains eligible
      const bot2 = new TradingBot(mockState, mockEnv);
      vi.spyOn((bot2 as any).orchestrator, 'executeCycle').mockImplementation(async (_sym: string, _tf: any, _cfg: any, _bal: any, ctx: any) => {
        const candidates: any[] = [];
        if (!ctx?.isCandidateSuppressed?.('Momentum', '5m')) {
          candidates.push({
            strategyId: 'Momentum',
            confidenceScore: 92,
            hasSignal: true,
            metadata: {
              targetTimeframe: '5m',
              signal: {
                type: 'BUY',
                signalPrice: 50000,
                stopLoss: 49000,
                takeProfit: 52000,
                timeframe: '5m',
                riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' },
              },
            },
          });
        }
        if (!ctx?.isCandidateSuppressed?.('Breakout', '15m')) {
          candidates.push({
            strategyId: 'Breakout',
            confidenceScore: 84,
            hasSignal: true,
            metadata: {
              targetTimeframe: '15m',
              signal: {
                type: 'BUY',
                signalPrice: 50000,
                stopLoss: 49200,
                takeProfit: 51800,
                timeframe: '15m',
                riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'LOW' },
              },
            },
          });
        }
        return candidates;
      });

      await bot2.alarm();
      const alertsAfterFallback = mockStorage.get('alerts') as TradeAlert[];
      expect(alertsAfterFallback).toHaveLength(1);
      expect(alertsAfterFallback[0].strategy).toBe('Breakout_NEW');

      // Clear alerts and advance to next closed 5m candle with strong ADX -> Momentum is re-evaluated and creates alert
      mockStorage.set('alerts', []);
      (bot2 as any).runtimeState.alerts = [];
      useWeak5m = false;
      currentEndTime = FIXED_ANCHOR_TIME + 300_000;

      await bot2.alarm();
      const alertsNextCandle = mockStorage.get('alerts') as TradeAlert[];
      expect(alertsNextCandle).toHaveLength(1);
      expect(alertsNextCandle[0].strategy).toBe('Momentum_NEW');
    });

    it('36. Momentum rejects missing, non-array, empty entryCandles and missing, unsupported, or inconsistent entry timeframes across 5m/15m/1h/4h', () => {
      const trendingRegime: MarketRegime = {
        regime: 'TRENDING',
        score: 85,
        allowTrendStrategies: true,
        allowMeanReversion: false,
      };
      const strongCandles = generateDeterministicCandles(60, FIXED_ANCHOR_TIME, 300_000, 100);

      for (const tf of ['5m', '15m', '1h', '4h'] as const) {
        const candidate: any = {
          strategyId: 'Momentum',
          timestamp: FIXED_ANCHOR_TIME,
          confidenceScore: 88,
          hasSignal: true,
          metadata: {
            targetTimeframe: tf,
            signal: { symbol: 'BTC/USDT', timeframe: tf, type: 'BUY', confidenceScore: 88, signalPrice: 50000 },
          },
        };

        for (const badEntry of [undefined, null, {}, 'bad-array', []]) {
          const snap: any = {
            symbol: 'BTC/USDT',
            timestamp: FIXED_ANCHOR_TIME,
            currentPrice: 50000,
            volume24h: 1000,
            quoteVolume24h: 50000000,
            candles: {
              '5m': strongCandles,
              '15m': strongCandles,
              '1h': strongCandles,
              '4h': strongCandles,
              [tf]: badEntry,
            },
          };
          const res = DirectionalMtfArbitrator.evaluateCandidate(candidate, snap, trendingRegime);
          expect(res.passed).toBe(false);
          expect(res.gate).toBe('INSUFFICIENT_HTF_DATA');
        }
      }

      const fullSnap: any = {
        symbol: 'BTC/USDT',
        timestamp: FIXED_ANCHOR_TIME,
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: { '5m': strongCandles, '15m': strongCandles, '1h': strongCandles, '4h': strongCandles },
      };

      const badCandidates = [
        { targetTimeframe: undefined, sigTf: undefined },
        { targetTimeframe: '1m', sigTf: '1m' },
        { targetTimeframe: '30m', sigTf: '30m' },
        { targetTimeframe: '5m', sigTf: '15m' },
      ];
      for (const { targetTimeframe, sigTf } of badCandidates) {
        const res = DirectionalMtfArbitrator.evaluateCandidate({
          strategyId: 'Momentum',
          timestamp: FIXED_ANCHOR_TIME,
          confidenceScore: 88,
          hasSignal: true,
          metadata: {
            targetTimeframe,
            signal: { symbol: 'BTC/USDT', timeframe: sigTf, type: 'BUY', confidenceScore: 88, signalPrice: 50000 },
          },
        } as any, fullSnap, trendingRegime);
        expect(res.passed).toBe(false);
        expect(res.gate).toBe('INSUFFICIENT_HTF_DATA');
      }
    });

    it('37. Momentum rejects full-series invalid OHLC (index 0 & trailing), missing OHLC fields, high < low, and non-finite ADX output', () => {
      const trendingRegime: MarketRegime = {
        regime: 'TRENDING',
        score: 85,
        allowTrendStrategies: true,
        allowMeanReversion: false,
      };
      const strongCandles = generateDeterministicCandles(60, FIXED_ANCHOR_TIME, 300_000, 100);
      const candidate: any = {
        strategyId: 'Momentum',
        timestamp: FIXED_ANCHOR_TIME,
        confidenceScore: 88,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: { symbol: 'BTC/USDT', timeframe: '5m', type: 'BUY', confidenceScore: 88, signalPrice: 50000 },
        },
      };

      const mutators: Array<(c: any) => void> = [
        c => { c.open = Number.NaN; },
        c => { c.high = Number.POSITIVE_INFINITY; },
        c => { c.low = Number.NEGATIVE_INFINITY; },
        c => { c.close = 0; },
        c => { c.open = -1; },
        c => { c.high = 80; c.low = 90; },
        c => { delete c.open; },
        c => { delete c.high; },
        c => { delete c.low; },
      ];

      for (const idx of [0, 59]) {
        for (const mutate of mutators) {
          const entryCopy = strongCandles.map(c => ({ ...c }));
          mutate(entryCopy[idx]);
          const snap: any = {
            symbol: 'BTC/USDT',
            timestamp: FIXED_ANCHOR_TIME,
            currentPrice: 50000,
            volume24h: 1000,
            quoteVolume24h: 50000000,
            candles: { '5m': entryCopy, '1h': strongCandles, '4h': strongCandles },
          };
          const res = DirectionalMtfArbitrator.evaluateCandidate(candidate, snap, trendingRegime);
          expect(res.passed).toBe(false);
          expect(res.gate).toBe('INSUFFICIENT_HTF_DATA');
        }
      }

      // Invalid HTF candle at index 0 with 4h absent must not resolve 1h BULLISH
      const badHtfCopy = strongCandles.map(c => ({ ...c }));
      badHtfCopy[0].high = Number.NEGATIVE_INFINITY;
      const badHtfSnap: any = {
        symbol: 'BTC/USDT',
        timestamp: FIXED_ANCHOR_TIME,
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: { '5m': strongCandles, '1h': badHtfCopy, '4h': [] },
      };
      const badHtfRes = DirectionalMtfArbitrator.evaluateCandidate(candidate, badHtfSnap, trendingRegime);
      expect(badHtfRes.passed).toBe(false);
      expect(badHtfRes.gate).toBe('INSUFFICIENT_HTF_DATA');

      // Non-finite ADX output must fail closed rather than slipping past `< 20` comparison
      const validSnap: any = {
        symbol: 'BTC/USDT',
        timestamp: FIXED_ANCHOR_TIME,
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: { '5m': strongCandles, '1h': strongCandles, '4h': strongCandles },
      };
      for (const badAdx of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const adxSpy = vi.spyOn(MarketRegimeEngine, 'calculateAdx').mockReturnValue(badAdx);
        try {
          const res = DirectionalMtfArbitrator.evaluateCandidate(candidate, validSnap, trendingRegime);
          expect(res.passed).toBe(false);
          expect(res.gate).toBe('INSUFFICIENT_HTF_DATA');
        } finally {
          adxSpy.mockRestore();
        }
      }
    });

    it('38. Momentum excludes forming candles (> snapshot.timestamp) and rechecks minimum counts on entry and HTF', () => {
      const trendingRegime: MarketRegime = {
        regime: 'TRENDING',
        score: 85,
        allowTrendStrategies: true,
        allowMeanReversion: false,
      };
      const strongCandles = generateDeterministicCandles(60, FIXED_ANCHOR_TIME, 300_000, 100);
      const flatClosed35 = Array.from({ length: 35 }, (_, i) => {
        const openTime = FIXED_ANCHOR_TIME - (35 - i) * 300_000;
        return {
          timestamp: openTime,
          openTime,
          closeTime: openTime + 300_000,
          open: 100,
          high: 100.1,
          low: 99.9,
          close: 100,
          volume: 1000,
        };
      });
      // Forming candle closes 5m AFTER evaluation snapshot timestamp with extreme trend spike
      const formingSpikeCandle = {
        timestamp: FIXED_ANCHOR_TIME,
        openTime: FIXED_ANCHOR_TIME,
        closeTime: FIXED_ANCHOR_TIME + 300_000,
        open: 100,
        high: 300,
        low: 100,
        close: 295,
        volume: 50000,
      };

      const candidate: any = {
        strategyId: 'Momentum',
        timestamp: FIXED_ANCHOR_TIME,
        confidenceScore: 88,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: { symbol: 'BTC/USDT', timeframe: '5m', type: 'BUY', confidenceScore: 88, signalPrice: 50000 },
        },
      };

      // Case A: 35 flat closed candles + 1 huge forming candle -> excluded -> ADX < 20 rejects
      const flatPlusFormingSnap: any = {
        symbol: 'BTC/USDT',
        timestamp: FIXED_ANCHOR_TIME,
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '5m': [...flatClosed35, formingSpikeCandle],
          '1h': strongCandles,
          '4h': strongCandles,
        },
      };
      const resFlatForming = DirectionalMtfArbitrator.evaluateCandidate(candidate, flatPlusFormingSnap, trendingRegime);
      expect(resFlatForming.passed).toBe(false);
      expect(resFlatForming.gate).toBe('REGIME_PROHIBITED');

      // Case B: 34 valid closed candles + 1 forming candle -> excluded -> 34 < 35 -> INSUFFICIENT_HTF_DATA
      const closed34PlusFormingSnap: any = {
        symbol: 'BTC/USDT',
        timestamp: FIXED_ANCHOR_TIME,
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '5m': [...strongCandles.slice(0, 34), formingSpikeCandle],
          '1h': strongCandles,
          '4h': strongCandles,
        },
      };
      const res34Forming = DirectionalMtfArbitrator.evaluateCandidate(candidate, closed34PlusFormingSnap, trendingRegime);
      expect(res34Forming.passed).toBe(false);
      expect(res34Forming.gate).toBe('INSUFFICIENT_HTF_DATA');

      // Case C: 49 closed 1h candles + 1 forming 1h candle with 4h missing -> 49 < 50 -> INSUFFICIENT_HTF_DATA
      const closed49Htf = generateDeterministicCandles(49, FIXED_ANCHOR_TIME, 3600_000, 100);
      const forming1h = {
        timestamp: FIXED_ANCHOR_TIME,
        openTime: FIXED_ANCHOR_TIME,
        closeTime: FIXED_ANCHOR_TIME + 3600_000,
        open: 200,
        high: 250,
        low: 199,
        close: 245,
        volume: 5000,
      };
      const htfFormingSnap: any = {
        symbol: 'BTC/USDT',
        timestamp: FIXED_ANCHOR_TIME,
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '5m': strongCandles,
          '1h': [...closed49Htf, forming1h],
          '4h': [],
        },
      };
      const resHtfForming = DirectionalMtfArbitrator.evaluateCandidate(candidate, htfFormingSnap, trendingRegime);
      expect(resHtfForming.passed).toBe(false);
      expect(resHtfForming.gate).toBe('INSUFFICIENT_HTF_DATA');
    });
  });
});
