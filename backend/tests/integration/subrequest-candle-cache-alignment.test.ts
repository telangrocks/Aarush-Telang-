import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrategyRegistry } from '../../src/engine/strategies/StrategyRegistry';
import { StrategyOrchestrator } from '../../src/engine/orchestrator/StrategyOrchestrator';
import { MarketDataEngine } from '../../src/engine/market-data/MarketDataEngine';
import { AdapterCandleProvider } from '../../src/engine/market-data/AdapterCandleProvider';
import { Timeframe } from '../../src/engine/market-data/Timeframe';
import { TradingBot } from '../../src/trading-bot';

// Mock crypto
vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('mock_decrypted_secret'),
  encrypt: vi.fn().mockResolvedValue({ iv: 'iv', encrypted: 'enc', salt: 'salt' }),
  cleanCredential: vi.fn().mockImplementation((k: any) => k),
}));

// Mock notifications
vi.mock('../../src/handlers/notifications', () => ({
  sendTradeNotification: vi.fn().mockResolvedValue({ success: true }),
}));

function createSyntheticCandles(count = 210, basePrice = 50000, intervalMs = 300000) {
  const now = 1789000000000;
  const candles = [];
  for (let i = 0; i < count; i++) {
    const openTime = now - (count - i) * intervalMs;
    const p = basePrice + i * 0.5;
    candles.push({
      timestamp: openTime,
      openTime,
      open: p - 0.5,
      high: p + 1.0,
      low: p - 1.0,
      close: p,
      volume: 1000 + i * 10,
    });
  }
  return candles;
}

describe('Subrequest Optimization: Kline Candle Cache Alignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. Verifies strategy manifests define minimumCandles and compute matching 203 candle limit', () => {
    const registry = StrategyRegistry.getInstance();
    const manifests = registry.getAllManifests();

    const timeframesSet = new Set<Timeframe>();
    const SAFE_CANDLE_BUFFER = 2;
    let cycleCandleLimit = 200;

    for (const m of manifests) {
      for (const tf of m.supportedTimeframes || []) timeframesSet.add(tf);
      const minCandles = typeof m.minimumCandles === 'number'
        ? m.minimumCandles
        : (typeof (m as any).requiredCandles === 'number' ? (m as any).requiredCandles : undefined);
      if (typeof minCandles === 'number') {
        cycleCandleLimit = Math.max(cycleCandleLimit, minCandles + SAFE_CANDLE_BUFFER);
      }
    }

    // ScalperV2 is 200, Momentum is 201 -> max(200, 201 + 2) = 203
    expect(cycleCandleLimit).toBe(203);

    // Union of supported timeframes across default strategies
    expect(Array.from(timeframesSet).sort()).toEqual(['15m', '1h', '4h', '5m']);
  });

  it('2. Proves MarketDataEngine reuses cached snapshot when limit is aligned (0 extra outbound calls)', async () => {
    let klineCallCount = 0;
    let tickerCallCount = 0;

    const mockAdapter = {
      fetchTicker: vi.fn().mockImplementation((sym: string) => {
        tickerCallCount++;
        return Promise.resolve({
          symbol: sym.replace('/', ''),
          last: 50000,
          bid: 49990,
          ask: 50010,
          volume: 1000,
          quoteVolume: 50000000,
        });
      }),
      fetchKlines: vi.fn().mockImplementation((_sym: string, _tf: string, limit: number) => {
        klineCallCount++;
        return Promise.resolve(createSyntheticCandles(limit));
      }),
    };

    const provider = new AdapterCandleProvider(mockAdapter as any);
    const dataEngine = new MarketDataEngine(provider);
    const orchestrator = new StrategyOrchestrator();
    orchestrator.setMarketDataEngine(dataEngine);

    // 1. Execute strategy evaluation cycle (which calls getSnapshot with targetTimeframes and candleLimit = 203)
    await orchestrator.executeCycle('BTC/USDT', undefined, undefined, 1000);

    const initialKlineCalls = klineCallCount;
    const initialTickerCalls = tickerCallCount;

    // 1 ticker + 4 timeframes (5m, 15m, 1h, 4h) = 4 kline calls
    expect(initialKlineCalls).toBe(4);
    expect(initialTickerCalls).toBe(1);

    // 2. Call getSnapshot with the aligned candleLimit (203) and timeframes
    const cycleTimeframes: Timeframe[] = ['5m', '15m', '1h', '4h'];
    const cycleCandleLimit = 203;

    const snapshot = await dataEngine.getSnapshot('BTC/USDT', cycleTimeframes, cycleCandleLimit);

    // Must hit in-memory cache: zero additional calls to fetchKlines or fetchTicker
    expect(klineCallCount).toBe(initialKlineCalls);
    expect(tickerCallCount).toBe(initialTickerCalls);
    expect(snapshot.currentPrice).toBe(50000);
    expect(snapshot.candles['5m'].length).toBeGreaterThan(0);

    // 3. Contrast with unaligned limit (100): misses cache and issues 4 extra kline calls
    const unalignedLimit = 100;
    await dataEngine.getSnapshot('BTC/USDT', cycleTimeframes, unalignedLimit);
    expect(klineCallCount).toBe(initialKlineCalls + 4); // 4 redundant kline calls triggered!
  });

  it('3. End-to-end TradingBot alarm cycle eliminates redundant klines while preserving signal evaluation', async () => {
    let klineCallCount = 0;
    let tickerCallCount = 0;

    const mockAdapter = {
      fetchTicker: vi.fn().mockImplementation((sym: string) => {
        tickerCallCount++;
        return Promise.resolve({
          symbol: sym,
          last: 50000,
          bid: 49990,
          ask: 50010,
          volume: 1000,
          quoteVolume: 50000000,
        });
      }),
      fetchKlines: vi.fn().mockImplementation((_sym: string, _tf: string, limit: number) => {
        klineCallCount++;
        return Promise.resolve(createSyntheticCandles(limit));
      }),
      fetchBalance: vi.fn().mockResolvedValue({
        free: { USDT: 5000 },
        total: { USDT: 5000 },
      }),
      fetchPositions: vi.fn().mockResolvedValue([]),
    };

    const mockStorage = new Map<string, any>();
    const mockState: any = {
      id: { toString: () => 'test-candle-alignment-do' },
      storage: {
        get: vi.fn().mockImplementation(async (key: string) => mockStorage.get(key)),
        put: vi.fn().mockImplementation(async (key: string, val: any) => { mockStorage.set(key, val); }),
        delete: vi.fn().mockImplementation(async (key: string) => { mockStorage.delete(key); }),
        setAlarm: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockImplementation(async (options?: any) => {
          const prefix = options?.prefix || '';
          const result = new Map();
          for (const [k, v] of mockStorage.entries()) {
            if (k.startsWith(prefix)) result.set(k, v);
          }
          return result;
        }),
        transaction: vi.fn().mockImplementation(async (cb: any) => {
          await cb({
            get: async (k: string) => mockStorage.get(k),
            put: async (k: string, v: any) => mockStorage.set(k, v),
            delete: async (k: string) => mockStorage.delete(k),
          });
        }),
      },
      blockConcurrencyWhile: vi.fn().mockImplementation(async (fn: any) => fn()),
    };

    const mockEnv: any = {
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({
              exchange_name: 'bybit',
              exchange_environment: 'demo',
              exchange_region: 'EU',
              exchange_api_key: 'mock_key',
              exchange_api_secret_encrypted: 'mock_enc',
              exchange_api_secret_iv: 'mock_iv',
              exchange_api_secret_salt: 'mock_salt',
            }),
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockResolvedValue({ success: true }),
          }),
        }),
      },
    };

    const { ExchangeManager } = await import('../../src/exchanges');
    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set('isActive', true);
    mockStorage.set('userId', 'user-candle-cache-test');
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('positionSize', 100);
    mockStorage.set('monitoredSymbols', ['BTC/USDT']);
    mockStorage.set('lock:alarmGeneration', 1);
    mockStorage.set('alerts', []);

    await bot.alarm();

    // Outbound kline calls must be exactly 4 (one per timeframe for BTC/USDT), NOT 8
    expect(klineCallCount).toBe(4);

    // newAnalysis must be persisted in DO storage with valid mapped snapshot
    const newAnalysis = mockStorage.get('newAnalysis');
    expect(newAnalysis).toBeDefined();
    expect(newAnalysis.symbol).toBe('BTC/USDT');
    expect(newAnalysis.price).toBe(50000);
    expect(newAnalysis.strategyAnalyses).toBeDefined();
  });
});
