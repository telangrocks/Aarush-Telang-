import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketOpportunityScanner } from '../../src/engine/scanner/MarketOpportunityScanner';
import { TradingBot } from '../../src/trading-bot';
import { ExchangeManager } from '../../src/exchanges';
import { IExchangeProvider } from '../../src/exchanges/IExchangeProvider';
import { ICandleProvider } from '../../src/infrastructure/exchange/types';
import { CandleValidator } from '../../src/infrastructure/exchange/CandleValidator';
import { ScannerTimeframe } from '../../src/engine/scanner/MultiTimeframeCandleStore';

vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('mocked_secret_key'),
}));

vi.mock('../../src/handlers/notifications', () => ({
  sendTradeNotification: vi.fn().mockResolvedValue({ success: true, dispatchedCount: 1, failedCount: 0, messageIds: [] }),
  sendTradeFillNotification: vi.fn().mockResolvedValue({ success: true, dispatchedCount: 1, failedCount: 0, messageIds: [] }),
}));

vi.mock('../../src/exchanges', async (importOriginal) => {
  const actual: any = await importOriginal();
  const makeCandles = (count = 205, tfMs = 300_000) => {
    const now = Date.now();
    const baseTime = now - count * tfMs;
    return Array.from({ length: count }, (_, i) => {
      const p = 100 + i * 0.25;
      return {
        timestamp: baseTime + i * tfMs,
        openTime: baseTime + i * tfMs,
        closeTime: baseTime + (i + 1) * tfMs,
        open: p - 0.1,
        high: p + 0.5,
        low: p - 0.5,
        close: p,
        volume: 2000 + i * 10,
      };
    });
  };
  const sharedProvider = {
    fetchTicker: vi.fn().mockResolvedValue({
      symbol: 'BTC/USDT',
      last: 150,
      bid: 149.9,
      ask: 150.1,
      high: 155,
      low: 145,
      volume: 10000,
      quoteVolume: 1500000,
    }),
    fetchKlines: vi.fn().mockImplementation(async (_sym: string, tf: string) =>
      makeCandles(205, CandleValidator.timeframeToMs(tf as ScannerTimeframe))
    ),
    fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 1000 }, total: { USDT: 1000 } }),
    fetchMarkets: vi.fn().mockResolvedValue([
      {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        quote: 'USDT',
        active: true,
        category: 'linear',
        precision: { amount: 0.001, price: 0.1 },
        limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } },
      },
      {
        id: 'ETHUSDT',
        symbol: 'ETH/USDT',
        quote: 'USDT',
        active: true,
        category: 'linear',
        precision: { amount: 0.01, price: 0.1 },
        limits: { cost: { min: 5 }, amount: { min: 0.01, max: 1000 } },
      },
    ]),
    fetchMarket: vi.fn().mockImplementation(async (sym: string) => ({
      id: sym.replace('/', ''),
      symbol: sym,
      quote: 'USDT',
      active: true,
      category: 'linear',
      precision: { amount: 0.001, price: 0.1 },
      limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } },
    })),
    fetchPositions: vi.fn().mockResolvedValue([]),
  };

  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue(sharedProvider),
    },
    normalizeEnvironment: vi.fn().mockReturnValue('testnet'),
    normalizeRegion: vi.fn().mockReturnValue('global'),
  };
});

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx].toFixed(3));
}

describe('Phase 2 Latency Benchmark (Scanner + TradingBot.alarm)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('measures MarketOpportunityScanner.scan() and TradingBot.alarm() median and p95 latency', async () => {
    const markets = Array.from({ length: 20 }, (_, i) => ({
      id: `COIN${i + 1}USDT`,
      symbol: `COIN${i + 1}/USDT`,
      base: `COIN${i + 1}`,
      quote: 'USDT',
      active: true,
      category: 'linear',
      contractType: 'LinearPerpetual',
      limits: { cost: { min: 5 }, amount: { min: 0.01, max: 1000 } },
      precision: { price: 0.01, amount: 0.01 },
    }));

    const candleMap: Record<string, any[]> = {};
    for (const tf of ['5m', '15m', '1h', '4h'] as const) {
      const tfMs = CandleValidator.timeframeToMs(tf);
      const now = Date.now();
      candleMap[tf] = Array.from({ length: 65 }, (_, i) => {
        const c = 100 + i * 0.4;
        return {
          timestamp: now - (65 - i) * tfMs,
          openTime: now - (65 - i) * tfMs,
          open: c - 0.1,
          high: c + 0.5,
          low: c - 0.5,
          close: c,
          volume: 10000 + i * 50,
        };
      });
    }

    const scannerProvider = {
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockImplementation(async (syms: string[]) =>
        syms.map((sym, i) => ({
          symbol: sym,
          last: 100 + i,
          bid: 99.9 + i,
          ask: 100.1 + i,
          quoteVolume: 20_000_000,
          high: 105 + i,
          low: 95 + i,
          timestamp: Date.now(),
        }))
      ),
      fetchCandles: vi.fn().mockImplementation(async (_sym: string, tf: string) => candleMap[tf] || candleMap['15m']),
    } as unknown as IExchangeProvider & ICandleProvider;

    const scanner = new MarketOpportunityScanner(scannerProvider);
    for (let w = 0; w < 2; w++) {
      await scanner.scan({ tradeAmountUsdt: 100 });
    }
    const scanTimes: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      await scanner.scan({ tradeAmountUsdt: 100 });
      scanTimes.push(performance.now() - t0);
    }
    scanTimes.sort((a, b) => a - b);

    // TradingBot.alarm() setup
    const storageMap = new Map<string, any>();
    storageMap.set('isActive', true);
    storageMap.set('coinId', 'BTC/USDT');
    storageMap.set('userId', 'bench-user');
    storageMap.set('strategy', 'scalper-v2');
    storageMap.set('positionSize', 100);
    storageMap.set('lock:alarmGeneration', 1);
    storageMap.set('approvedCandidateRecord', {
      approvalGeneration: 1,
      userId: 'bench-user',
      budgetUsdt: 100,
      approvedSymbols: ['BTCUSDT', 'ETHUSDT'],
      approvalState: 'FINAL_APPROVED',
      exchangeName: 'bybit',
      environment: 'testnet',
      accountFingerprint: 'bybit:testnet',
      orderType: 'ALL',
      approvedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      symbolMetadataSnapshot: {},
    });

    const mockState: any = {
      id: { toString: () => 'bench-do-id' },
      storage: {
        get: async (k: string | string[]) => {
          if (Array.isArray(k)) {
            const m = new Map();
            for (const item of k) if (storageMap.has(item)) m.set(item, storageMap.get(item));
            return m;
          }
          return storageMap.get(k);
        },
        put: async (k: string | Record<string, any>, v?: any) => {
          if (typeof k === 'string') storageMap.set(k, v);
          else for (const [ek, ev] of Object.entries(k)) storageMap.set(ek, ev);
        },
        delete: async (k: string) => storageMap.delete(k),
        setAlarm: vi.fn(),
        list: async (opts?: any) => {
          if (opts?.prefix) {
            const m = new Map();
            for (const [k, v] of storageMap.entries()) if (k.startsWith(opts.prefix)) m.set(k, v);
            return m;
          }
          return storageMap;
        },
        transaction: async (cb: any) => cb(mockState.storage),
      },
      blockConcurrencyWhile: async (cb: any) => cb(),
    };

    const mockDb: any = {
      prepare: vi.fn().mockImplementation((q: string) => {
        if (q.includes('PRAGMA table_info')) {
          return { all: vi.fn().mockResolvedValue({ results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] }) };
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
          first: vi.fn().mockResolvedValue(null),
        };
      }),
    };

    const sentEnvelopes: any[] = [];
    const mockEnv: any = {
      DB: mockDb,
      GLOBAL_TRADING_HALT: 'false',
      ENCRYPTION_KEY: 'bench-key',
      TELEMETRY_QUEUE: {
        send: vi.fn().mockImplementation(async (envlp: any) => {
          sentEnvelopes.push(envlp);
        }),
      },
    };

    const bot = new TradingBot(mockState, mockEnv);
    for (let w = 0; w < 2; w++) {
      await bot.alarm();
    }
    const alarmTimes: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      await bot.alarm();
      alarmTimes.push(performance.now() - t0);
    }
    alarmTimes.sort((a, b) => a - b);

    const summary = {
      scannerMedianMs: computePercentile(scanTimes, 50),
      scannerP95Ms: computePercentile(scanTimes, 95),
      alarmMedianMs: computePercentile(alarmTimes, 50),
      alarmP95Ms: computePercentile(alarmTimes, 95),
      envelopesSent: sentEnvelopes.length,
    };

    console.log('[BENCHMARK_METRICS]', JSON.stringify(summary));
    expect(summary.scannerMedianMs).toBeGreaterThanOrEqual(0);
    expect(summary.alarmMedianMs).toBeGreaterThanOrEqual(0);
  });
});
