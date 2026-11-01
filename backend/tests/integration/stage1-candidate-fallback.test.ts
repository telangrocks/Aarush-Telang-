import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradingBot, TradeAlert } from '../../src/trading-bot';
import { sendTradeNotification } from '../../src/handlers/notifications';
import { ExchangeManager } from '../../src/exchanges';
import { StrategyRegistry } from '../../src/engine/strategies/StrategyRegistry';

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

  // 4. First strategy fails position-size validation; next succeeds
  it('4. falls back to next strategy when first strategy has invalid position size (<= 0)', async () => {
    const bot = setupBot('BTC/USDT', { positionSize: 0 }); // dynamic sizing from recommendation
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 0, riskClassification: 'LOW' } } } },
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 150, riskClassification: 'LOW' } } } },
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0].strategy).toBe('Momentum_NEW');
    expect(alerts[0].positionSize).toBe(150);
  });

  // 5. First strategy fails exposure validation; next succeeds within remaining exposure
  it('5. falls back when first strategy exceeds portfolio exposure limit, next fits within remaining', async () => {
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
    expect(alerts).toHaveLength(1);
    expect(alerts[0].strategy).toBe('Momentum_NEW');
    expect(alerts[0].positionSize).toBe(150);
  });

  // 6. Exposure is independently recalculated for every proposed strategy signal
  it('6. independently recalculates portfolio exposure for each candidate signal', async () => {
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
    expect(alerts).toHaveLength(1);
    expect(alerts[0].strategy).toBe('Breakout_NEW');
  });

  // 7. First strategy fails execution eligibility; next succeeds
  it('7. falls back when first strategy fails execution eligibility (budget < minNotional)', async () => {
    const bot = setupBot('BTC/USDT', { positionSize: 0 });
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 2, riskClassification: 'LOW' } } } }, // $2 < minNotional $5
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 50, riskClassification: 'LOW' } } } }, // $50 >= minNotional
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0].strategy).toBe('Momentum_NEW');
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

  // 13. Missing quantity step-size metadata blocks further strategies for that ticker
  it('13. stops strategy evaluation for that ticker if stepSize is missing', async () => {
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

  // 23. All strategies failing produces no new alert
  it('23. produces zero alerts when all candidates fail candidate-specific gates', async () => {
    const bot = setupBot('BTC/USDT', { positionSize: 0 });
    vi.spyOn((bot as any).orchestrator, 'executeCycle').mockResolvedValue([
      { strategyId: 'ScalperV2', confidenceScore: 90, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49500, takeProfit: 51000, timeframe: '5m', riskAssessment: { positionSizeRecommendation: 100, riskClassification: 'EXTREME' } } } }, // fails risk
      { strategyId: 'Momentum', confidenceScore: 85, hasSignal: true, metadata: { signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000, timeframe: '15m', riskAssessment: { positionSizeRecommendation: 0, riskClassification: 'LOW' } } } }, // fails size
    ]);

    await bot.alarm();
    const alerts = mockStorage.get('alerts') as TradeAlert[];
    expect(alerts).toHaveLength(0);
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
});
