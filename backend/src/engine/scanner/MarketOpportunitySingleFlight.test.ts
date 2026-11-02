import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleGetMarketOpportunities,
  handleGetPersonalizedMarketCandidates,
  buildPublicOpportunityCacheKey,
  __resetPublicOpportunityStateForTests,
  __getPublicOpportunityDiagnosticsForTests,
} from '../../handlers/exchange';
import { SingleFlightCoalescer } from '../../infrastructure/cache/SingleFlightCoalescer';
import { ExchangeManager } from '../../exchanges/ExchangeManager';
import { IExchangeProvider } from '../../exchanges/IExchangeProvider';
import { ICandleProvider } from '../../infrastructure/exchange/types';
import { CandleValidator } from '../../infrastructure/exchange/CandleValidator';
import { MarketOpportunityScanner } from './MarketOpportunityScanner';
import { DEFAULT_SCANNER_CONFIG, MarketOpportunity } from './ScannerTypes';
import { ScannerTimeframe } from './MultiTimeframeCandleStore';

function generateDeterministicCandles(
  timeframe: ScannerTimeframe,
  anchorNowMs: number,
  count: number = 65,
  trend: 'BULL' | 'BEAR' = 'BULL',
  baseOffset: number = 0
) {
  const tfMs = CandleValidator.timeframeToMs(timeframe);
  const startTime = anchorNowMs - count * tfMs;

  return Array.from({ length: count }, (_, i) => {
    const base = (trend === 'BULL' ? 100 + i * 2.5 : 500 - i * 2.5) + baseOffset;
    return {
      timestamp: startTime + i * tfMs,
      open: base - 0.5,
      high: base + 3.0,
      low: base - 3.0,
      close: base + (trend === 'BULL' ? 1.5 : -1.5),
      volume: 12000 + i * 150,
    };
  });
}

function buildEightSymbolUniverse(priceMultiplier: number = 1) {
  const symbols = [
    { id: 'BTCUSDT', symbol: 'BTC/USDT', px: 60000 * priceMultiplier, vol: 50_000_000, trend: 'BULL' as const },
    { id: 'ETHUSDT', symbol: 'ETH/USDT', px: 3200 * priceMultiplier, vol: 40_000_000, trend: 'BEAR' as const },
    { id: 'SOLUSDT', symbol: 'SOL/USDT', px: 150 * priceMultiplier, vol: 35_000_000, trend: 'BULL' as const },
    { id: 'XRPUSDT', symbol: 'XRP/USDT', px: 0.6 * priceMultiplier, vol: 28_000_000, trend: 'BEAR' as const },
    { id: 'ADAUSDT', symbol: 'ADA/USDT', px: 0.45 * priceMultiplier, vol: 22_000_000, trend: 'BULL' as const },
    { id: 'DOGEUSDT', symbol: 'DOGE/USDT', px: 0.15 * priceMultiplier, vol: 19_000_000, trend: 'BEAR' as const },
    { id: 'AVAXUSDT', symbol: 'AVAX/USDT', px: 35 * priceMultiplier, vol: 16_000_000, trend: 'BULL' as const },
    { id: 'LINKUSDT', symbol: 'LINK/USDT', px: 18 * priceMultiplier, vol: 14_000_000, trend: 'BEAR' as const },
  ];

  const markets = symbols.map((s) => ({
    id: s.id,
    symbol: s.symbol,
    quote: 'USDT',
    active: true,
    category: 'linear',
    contractType: 'LinearPerpetual',
    precision: { price: 0.01, amount: 0.001 },
    limits: { amount: { min: 0.001, max: 100000 }, cost: { min: 5 } },
  }));

  const tickers = symbols.map((s) => ({
    symbol: s.symbol,
    last: s.px,
    bid: s.px * 0.9999,
    ask: s.px * 1.0001,
    quoteVolume: s.vol,
    high: s.px * 1.03,
    low: s.px * 0.97,
    percentage: s.trend === 'BULL' ? 3.25 : -2.75,
  }));

  const trendBySymbol = new Map(symbols.map((s) => [s.symbol, s.trend]));
  return { markets, tickers, trendBySymbol };
}

function createMockContext(options: {
  userId: string;
  exchangeName?: string;
  environment?: string;
  region?: string;
  queryParams?: Record<string, string | undefined>;
  includeEncryptedColsSpy?: (sql: string) => void;
}) {
  const mockDb = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      options.includeEncryptedColsSpy?.(sql);
      return {
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            exchange_name: options.exchangeName ?? 'bybit',
            exchange_environment: options.environment ?? 'mainnet',
            exchange_region: options.region ?? 'india',
          }),
        }),
      };
    }),
  };

  let statusCode = 200;
  const ctx = {
    get: vi.fn().mockImplementation((k: string) => (k === 'jwtPayload' ? { sub: options.userId } : undefined)),
    env: {
      DB: mockDb,
      ENCRYPTION_KEY: 'unused-public-route-key',
    },
    status: vi.fn().mockImplementation((code: number) => {
      statusCode = code;
    }),
    json: vi.fn().mockImplementation((body: any) => ({ __httpStatus: statusCode, ...body })),
    req: {
      query: vi.fn().mockImplementation((param: string) => options.queryParams?.[param]),
    },
  } as any;

  return ctx;
}

/**
 * Normalizes ONLY volatile runtime metadata (timestamps, execution durations, generated UUIDs)
 * while preserving 100% original numerical precision AND all freshness / data-quality decisions.
 */
function normalizeVolatileOpportunityMetadata(opp: MarketOpportunity) {
  const {
    opportunityId: _volatileOpportunityId,
    timestamp: _volatileTimestamp,
    lastStateTransitionAt: _volatileTransitionAt,
    ...tradingFields
  } = opp;
  return tradingFields;
}

function normalizeVolatileResponseMetadata(responseBody: any) {
  const {
    __httpStatus,
    timestamp: _volatileTimestamp,
    executionDurationMs: _volatileDuration,
    opportunities,
    telemetry,
    ...stableEnvelope
  } = responseBody;

  const {
    cycleId: _volatileCycleId,
    timestamp: _volatileTelemetryTs,
    executionDurationMs: _volatileTelemetryDur,
    ...stableTelemetry
  } = telemetry || {};

  return {
    ...stableEnvelope,
    opportunities: (opportunities || []).map(normalizeVolatileOpportunityMetadata),
    telemetry: stableTelemetry,
  };
}

describe('Phase 1 — Shared Public Market-Data Cache & Single-Flight Coalescing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetPublicOpportunityStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetPublicOpportunityStateForTests();
  });

  it('1. coalesces 20 concurrent identical requests across distinct users into 1 upstream scan without reading encrypted credentials', async () => {
    const { markets, tickers, trendBySymbol } = buildEightSymbolUniverse();
    const executedSqlQueries: string[] = [];
    const providerConfigs: any[] = [];

    const mockAdapter = {
      fetchMarkets: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 15));
        return markets;
      }),
      fetchTickers: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 15));
        return tickers;
      }),
      fetchCandles: vi.fn().mockImplementation(async (sym: string, tf: ScannerTimeframe) => {
        await new Promise((r) => setTimeout(r, 5));
        return generateDeterministicCandles(tf, Date.now(), 65, trendBySymbol.get(sym) ?? 'BULL');
      }),
    } as unknown as IExchangeProvider & ICandleProvider;

    vi.spyOn(ExchangeManager, 'getProvider').mockImplementation(async (_ex, cfg) => {
      providerConfigs.push(cfg);
      return mockAdapter as any;
    });

    const contexts = Array.from({ length: 20 }, (_, idx) => {
      // Mix caller-specific query filters across concurrent callers
      const queryParams: Record<string, string | undefined> =
        idx === 18
          ? { direction: 'LONG', limit: '2' }
          : idx === 19
          ? { direction: 'SHORT' }
          : {};

      return createMockContext({
        userId: `concurrent-user-20-${idx}`,
        exchangeName: 'bybit',
        environment: 'mainnet',
        region: 'india',
        queryParams,
        includeEncryptedColsSpy: (sql) => executedSqlQueries.push(sql),
      });
    });

    const responses = await Promise.all(contexts.map((ctx) => handleGetMarketOpportunities(ctx) as Promise<any>));

    // Upstream call counts: 1 fetchMarkets + 1 fetchTickers + 32 fetchCandles (8 symbols * 4 TFs) = 34 total
    // vs 20 * 34 = 680 upstream requests before Phase 1.
    expect(mockAdapter.fetchMarkets).toHaveBeenCalledTimes(1);
    expect(mockAdapter.fetchTickers).toHaveBeenCalledTimes(1);
    expect(mockAdapter.fetchCandles).toHaveBeenCalledTimes(32);

    // Anonymous public provider verification
    expect(providerConfigs).toHaveLength(1);
    expect(providerConfigs[0].apiKey).toBeUndefined();
    expect(providerConfigs[0].secret).toBeUndefined();

    // SQL query must not select encrypted API key/secret columns
    expect(executedSqlQueries).toHaveLength(20);
    for (const sql of executedSqlQueries) {
      expect(sql).not.toContain('exchange_api_key_encrypted');
      expect(sql).not.toContain('exchange_api_secret_encrypted');
    }

    // All 20 callers succeed and share the exact same underlying scan cycleId and timestamp
    const baseTimestamp = responses[0].timestamp;
    const baseCycleId = responses[0].telemetry.cycleId;
    for (let i = 0; i < 20; i++) {
      expect(responses[i].__httpStatus).toBe(200);
      expect(responses[i].success).toBe(true);
      expect(responses[i].timestamp).toBe(baseTimestamp);
      expect(responses[i].telemetry.cycleId).toBe(baseCycleId);
    }

    // Unfiltered callers (0..17) receive all 8 opportunities; caller 18 gets LONG slice <=2; caller 19 gets SHORT only
    expect(responses[0].opportunities.length).toBe(8);
    expect(responses[18].opportunities.length).toBeLessThanOrEqual(2);
    expect(responses[18].opportunities.every((o: any) => o.dominantDirection === 'LONG')).toBe(true);
    expect(responses[19].opportunities.length).toBeGreaterThan(0);
    expect(responses[19].opportunities.every((o: any) => o.dominantDirection === 'SHORT')).toBe(true);
    // Unfiltered caller after filtered callers still has full unmutated 8 items
    expect(responses[17].opportunities.length).toBe(8);

    expect(__getPublicOpportunityDiagnosticsForTests().inFlightCount).toBe(0);
  });

  it('2. coalesces 100 concurrent identical requests into 1 upstream scan (34 subrequests vs 3,400 baseline) with clean teardown', async () => {
    const { markets, tickers, trendBySymbol } = buildEightSymbolUniverse();

    const mockAdapter = {
      fetchMarkets: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return markets;
      }),
      fetchTickers: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return tickers;
      }),
      fetchCandles: vi.fn().mockImplementation(async (sym: string, tf: ScannerTimeframe) => {
        await new Promise((r) => setTimeout(r, 4));
        return generateDeterministicCandles(tf, Date.now(), 65, trendBySymbol.get(sym) ?? 'BULL');
      }),
    } as unknown as IExchangeProvider & ICandleProvider;

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

    const contexts = Array.from({ length: 100 }, (_, idx) =>
      createMockContext({
        userId: `concurrent-user-100-${idx}`,
        exchangeName: 'bybit',
        environment: 'mainnet',
        region: 'india',
      })
    );

    const responses = await Promise.all(contexts.map((ctx) => handleGetMarketOpportunities(ctx) as Promise<any>));

    expect(mockAdapter.fetchMarkets).toHaveBeenCalledTimes(1);
    expect(mockAdapter.fetchTickers).toHaveBeenCalledTimes(1);
    expect(mockAdapter.fetchCandles).toHaveBeenCalledTimes(32);

    const cycleIds = new Set(responses.map((r) => r.telemetry.cycleId));
    expect(cycleIds.size).toBe(1);
    expect(responses.every((r) => r.__httpStatus === 200 && r.success === true && r.opportunities.length === 8)).toBe(true);
    expect(__getPublicOpportunityDiagnosticsForTests().inFlightCount).toBe(0);
  });

  it('3. honours 30s opportunity cache TTL and preserves MultiTimeframeCandleStore per-timeframe TTLs on refresh', async () => {
    vi.useFakeTimers();
    const startMs = 1_760_000_000_000;
    vi.setSystemTime(startMs);

    const { markets, tickers, trendBySymbol } = buildEightSymbolUniverse();
    const mockAdapter = {
      fetchMarkets: vi.fn().mockImplementation(async () => markets),
      fetchTickers: vi.fn().mockImplementation(async () => tickers),
      fetchCandles: vi.fn().mockImplementation(async (sym: string, tf: ScannerTimeframe) =>
        generateDeterministicCandles(tf, Date.now(), 65, trendBySymbol.get(sym) ?? 'BULL')
      ),
    } as unknown as IExchangeProvider & ICandleProvider;

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

    // t = 0s: Cold cache -> 1 markets, 1 tickers, 32 candles (8 symbols * 4 TFs)
    const r1 = (await handleGetMarketOpportunities(createMockContext({ userId: 'ttl-user-1' }))) as any;
    expect(r1.success).toBe(true);
    expect(mockAdapter.fetchMarkets).toHaveBeenCalledTimes(1);
    expect(mockAdapter.fetchTickers).toHaveBeenCalledTimes(1);
    expect(mockAdapter.fetchCandles).toHaveBeenCalledTimes(32);

    // t = 15s (< 30s TTL): Warm cache hit for a DIFFERENT user -> 0 upstream calls
    vi.setSystemTime(startMs + 15_000);
    const r2 = (await handleGetMarketOpportunities(createMockContext({ userId: 'ttl-user-2' }))) as any;
    expect(r2.telemetry.cycleId).toBe(r1.telemetry.cycleId);
    expect(mockAdapter.fetchMarkets).toHaveBeenCalledTimes(1);
    expect(mockAdapter.fetchTickers).toHaveBeenCalledTimes(1);
    expect(mockAdapter.fetchCandles).toHaveBeenCalledTimes(32);

    // t = 31s (> 30s opportunity TTL; > 15s 5m candle TTL; < 60s 15m TTL; < 5m 1h TTL; < 15m 4h TTL)
    // Only 5m candles (8 symbols) expire and re-fetch; 4h, 1h, and 15m (24 series) are served from CandleStore!
    vi.setSystemTime(startMs + 31_000);
    const r3 = (await handleGetMarketOpportunities(createMockContext({ userId: 'ttl-user-3' }))) as any;
    expect(r3.success).toBe(true);
    expect(r3.telemetry.cycleId).not.toBe(r1.telemetry.cycleId);
    expect(mockAdapter.fetchMarkets).toHaveBeenCalledTimes(2);
    expect(mockAdapter.fetchTickers).toHaveBeenCalledTimes(2);
    expect(mockAdapter.fetchCandles).toHaveBeenCalledTimes(32 + 8);
  });

  it('4. does not cache failed or degraded scans, removes failed promises safely, and recovers on retry', async () => {
    const { markets, tickers, trendBySymbol } = buildEightSymbolUniverse();
    let shouldFailUpstream = true;

    const mockAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        if (shouldFailUpstream) {
          throw new Error('Bybit HTTP 429 Too Many Requests');
        }
        return tickers;
      }),
      fetchCandles: vi.fn().mockImplementation(async (sym: string, tf: ScannerTimeframe) =>
        generateDeterministicCandles(tf, Date.now(), 65, trendBySymbol.get(sym) ?? 'BULL')
      ),
    } as unknown as IExchangeProvider & ICandleProvider;

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

    // 8 concurrent requests during upstream outage coalesce onto 1 failed flight
    const failedResponses = await Promise.all(
      Array.from({ length: 8 }, (_, idx) =>
        handleGetMarketOpportunities(createMockContext({ userId: `fail-user-${idx}` })) as Promise<any>
      )
    );

    expect(mockAdapter.fetchTickers).toHaveBeenCalledTimes(1);
    for (const res of failedResponses) {
      expect(res.__httpStatus).toBe(500);
      expect(res.success).toBe(false);
      expect(res.error).toContain('429');
    }

    // Cache must NOT contain failed scan, and in-flight map must be completely empty
    const diagAfterFail = __getPublicOpportunityDiagnosticsForTests();
    expect(diagAfterFail.sharedCacheKeys).toHaveLength(0);
    expect(diagAfterFail.inFlightCount).toBe(0);

    // Recovery: upstream healthy -> immediate retry succeeds and populates cache
    shouldFailUpstream = false;
    const recoveredRes = (await handleGetMarketOpportunities(createMockContext({ userId: 'recovery-user' }))) as any;
    expect(recoveredRes.__httpStatus).toBe(200);
    expect(recoveredRes.success).toBe(true);
    expect(recoveredRes.opportunities.length).toBe(8);
    expect(__getPublicOpportunityDiagnosticsForTests().sharedCacheKeys).toHaveLength(1);

    // Degraded scan non-caching check (503 MARKET_DATA_DEGRADED must not poison cache)
    __resetPublicOpportunityStateForTests();
    const degradedAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue([markets[0]]),
      fetchTickers: vi.fn().mockResolvedValue([tickers[0]]),
      fetchCandles: vi.fn().mockResolvedValue([]), // Empty candles -> DATA_DEGRADED
    };
    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(degradedAdapter as any);

    const degradedResponses = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        handleGetMarketOpportunities(createMockContext({ userId: `deg-${i}`, environment: 'demo' })) as Promise<any>
      )
    );
    for (const dRes of degradedResponses) {
      expect(dRes.__httpStatus).toBe(503);
      expect(dRes.code).toBe('MARKET_DATA_DEGRADED');
    }
    expect(__getPublicOpportunityDiagnosticsForTests().sharedCacheKeys).toHaveLength(0);
    expect(__getPublicOpportunityDiagnosticsForTests().inFlightCount).toBe(0);

    // Direct unit check on SingleFlightCoalescer synchronous throw safety
    const coalescer = new SingleFlightCoalescer<number>();
    await expect(
      coalescer.do('sync-throw-key', () => {
        throw new Error('synchronous throw before promise return');
      })
    ).rejects.toThrow('synchronous throw');
    expect(coalescer.isInFlight('sync-throw-key')).toBe(false);
    expect(coalescer.getActiveCount()).toBe(0);
  });

  it('5. strictly isolates mainnet, testnet, demo, region, and scanner configuration cache keys', async () => {
    const mainnetData = buildEightSymbolUniverse(1);
    const testnetData = buildEightSymbolUniverse(0.25);

    const mainnetAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue([mainnetData.markets[0]]),
      fetchTickers: vi.fn().mockResolvedValue([mainnetData.tickers[0]]),
      fetchCandles: vi.fn().mockImplementation(async (_sym: string, tf: ScannerTimeframe) =>
        generateDeterministicCandles(tf, Date.now(), 65, 'BULL', 1000)
      ),
    };

    const testnetAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue([testnetData.markets[1]]),
      fetchTickers: vi.fn().mockResolvedValue([testnetData.tickers[1]]),
      fetchCandles: vi.fn().mockImplementation(async (_sym: string, tf: ScannerTimeframe) =>
        generateDeterministicCandles(tf, Date.now(), 65, 'BEAR', 0)
      ),
    };

    vi.spyOn(ExchangeManager, 'getProvider').mockImplementation(async (_ex, cfg) => {
      return (cfg.environment === 'testnet' ? testnetAdapter : mainnetAdapter) as any;
    });

    const [mainnetRes, testnetRes] = await Promise.all([
      handleGetMarketOpportunities(createMockContext({ userId: 'u-main', environment: 'mainnet' })) as Promise<any>,
      handleGetMarketOpportunities(createMockContext({ userId: 'u-test', environment: 'testnet' })) as Promise<any>,
    ]);

    expect(mainnetRes.opportunities).toHaveLength(1);
    expect(mainnetRes.opportunities[0].symbol).toBe('BTC/USDT');
    expect(mainnetRes.opportunities[0].dominantDirection).toBe('LONG');

    expect(testnetRes.opportunities).toHaveLength(1);
    expect(testnetRes.opportunities[0].symbol).toBe('ETH/USDT');
    expect(testnetRes.opportunities[0].dominantDirection).toBe('SHORT');

    // Verify dependency-complete key changes across every dimension
    const baseKey = buildPublicOpportunityCacheKey('bybit', 'mainnet', 'india', DEFAULT_SCANNER_CONFIG, 8, 70);
    expect(buildPublicOpportunityCacheKey('bybit', 'testnet', 'india', DEFAULT_SCANNER_CONFIG, 8, 70)).not.toBe(baseKey);
    expect(buildPublicOpportunityCacheKey('bybit', 'demo', 'india', DEFAULT_SCANNER_CONFIG, 8, 70)).not.toBe(baseKey);
    expect(buildPublicOpportunityCacheKey('bybit', 'mainnet', 'global', DEFAULT_SCANNER_CONFIG, 8, 70)).not.toBe(baseKey);
    expect(buildPublicOpportunityCacheKey('bybit', 'mainnet', 'india', DEFAULT_SCANNER_CONFIG, 12, 70)).not.toBe(baseKey);
    expect(buildPublicOpportunityCacheKey('bybit', 'mainnet', 'india', DEFAULT_SCANNER_CONFIG, 8, 100)).not.toBe(baseKey);
    expect(
      buildPublicOpportunityCacheKey(
        'bybit',
        'mainnet',
        'india',
        { ...DEFAULT_SCANNER_CONFIG, minNetEdgeRatio: 4.5 },
        8,
        70
      )
    ).not.toBe(baseKey);
  });

  it('6. isolates MultiTimeframeCandleStore instances per environment so cached mainnet candles never leak into testnet scans', async () => {
    vi.useFakeTimers();
    const t0 = 1_760_500_000_000;
    vi.setSystemTime(t0);

    const sharedMarket = [
      {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        quote: 'USDT',
        active: true,
        category: 'linear',
        contractType: 'LinearPerpetual',
      },
    ];
    const sharedTicker = [
      {
        symbol: 'BTC/USDT',
        last: 55000,
        bid: 54995,
        ask: 55005,
        quoteVolume: 45_000_000,
        high: 56500,
        low: 53500,
      },
    ];

    const mainnetAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(sharedMarket),
      fetchTickers: vi.fn().mockResolvedValue(sharedTicker),
      fetchCandles: vi.fn().mockImplementation(async (_sym: string, tf: ScannerTimeframe) =>
        generateDeterministicCandles(tf, Date.now(), 65, 'BULL', 500)
      ),
    };

    const testnetAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(sharedMarket),
      fetchTickers: vi.fn().mockResolvedValue(sharedTicker),
      fetchCandles: vi.fn().mockImplementation(async (_sym: string, tf: ScannerTimeframe) =>
        generateDeterministicCandles(tf, Date.now(), 65, 'BEAR', 0)
      ),
    };

    vi.spyOn(ExchangeManager, 'getProvider').mockImplementation(async (_ex, cfg) => {
      return (cfg.environment === 'testnet' ? testnetAdapter : mainnetAdapter) as any;
    });

    // Populate mainnet CandleStore for BTC/USDT (BULL -> LONG)
    const mainRes1 = (await handleGetMarketOpportunities(
      createMockContext({ userId: 'main-1', environment: 'mainnet' })
    )) as any;
    expect(mainRes1.opportunities[0].dominantDirection).toBe('LONG');
    expect(mainnetAdapter.fetchCandles).toHaveBeenCalledTimes(4);

    // Advance 31s so opportunity cache expires, while 4h/1h/15m candles in mainnet CandleStore remain warm
    vi.setSystemTime(t0 + 31_000);

    // Testnet scan for the SAME symbol BTC/USDT MUST NOT reuse mainnet's cached 4h/1h/15m BULL candles!
    const testRes = (await handleGetMarketOpportunities(
      createMockContext({ userId: 'test-1', environment: 'testnet' })
    )) as any;
    expect(testnetAdapter.fetchCandles).toHaveBeenCalledTimes(4);
    expect(testRes.opportunities[0].dominantDirection).toBe('SHORT');

    // Mainnet scan at t0 + 31s reuses mainnet's warm 4h/1h/15m candles (fetching only expired 5m) and stays LONG
    const mainRes2 = (await handleGetMarketOpportunities(
      createMockContext({ userId: 'main-2', environment: 'mainnet' })
    )) as any;
    expect(mainnetAdapter.fetchCandles).toHaveBeenCalledTimes(4 + 1);
    expect(mainRes2.opportunities[0].dominantDirection).toBe('LONG');

    const diag = __getPublicOpportunityDiagnosticsForTests();
    expect(diag.candleStoreKeys).toContain('bybit:mainnet:india:cd70');
    expect(diag.candleStoreKeys).toContain('bybit:testnet:india:cd70');
  });

  it('7. preserves strict multi-user personalization isolation on /api/market/candidates and caller filters on /api/market/opportunities', async () => {
    const markets = [
      {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        quote: 'USDT',
        active: true,
        category: 'linear',
        contractType: 'LinearPerpetual',
        precision: { price: 0.1, amount: 0.01 },
        limits: { amount: { min: 0.01, max: 10000 }, cost: { min: 500 } }, // Requires >= 500 USDT notional
      },
      {
        id: 'SOLUSDT',
        symbol: 'SOL/USDT',
        quote: 'USDT',
        active: true,
        category: 'linear',
        contractType: 'LinearPerpetual',
        precision: { price: 0.01, amount: 0.01 },
        limits: { amount: { min: 0.1, max: 100000 }, cost: { min: 5 } }, // Affordable with 25 USDT (0.16 SOL = 24 USDT)
      },
    ];
    const tickers = [
      { symbol: 'BTC/USDT', last: 60000, bid: 59995, ask: 60005, quoteVolume: 50_000_000, high: 61500, low: 58500 },
      { symbol: 'SOL/USDT', last: 150, bid: 149.98, ask: 150.02, quoteVolume: 25_000_000, high: 155, low: 145 },
    ];

    const mockAdapter = {
      loadMarkets: vi.fn().mockResolvedValue(markets),
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockResolvedValue(tickers),
      fetchCandles: vi.fn().mockImplementation(async (sym: string, tf: ScannerTimeframe) =>
        generateDeterministicCandles(tf, Date.now(), 65, sym === 'BTC/USDT' ? 'BULL' : 'BEAR')
      ),
    };

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

    // Public opportunities route returns both symbols unfiltered, while caller-specific filters stay isolated
    const [pubLongOnly, pubAll] = await Promise.all([
      handleGetMarketOpportunities(
        createMockContext({ userId: 'small-user', queryParams: { direction: 'LONG' } })
      ) as Promise<any>,
      handleGetMarketOpportunities(createMockContext({ userId: 'whale-user' })) as Promise<any>,
    ]);
    expect(pubLongOnly.opportunities.map((o: any) => o.symbol)).toEqual(['BTC/USDT']);
    expect(pubAll.opportunities).toHaveLength(2);

    // Personalized candidates route remains completely untouched and enforces per-user budget isolation
    const makeCandidatesCtx = (userId: string, budget: string) => ({
      get: vi.fn().mockReturnValue({ sub: userId }),
      env: {
        DB: {
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockReturnValue({
              first: vi.fn().mockResolvedValue({
                exchange_name: 'bybit',
                exchange_environment: 'mainnet',
              }),
            }),
          }),
        },
      },
      status: vi.fn(),
      json: vi.fn().mockImplementation((b: any) => b),
      req: { query: vi.fn().mockImplementation((k: string) => (k === 'budget' ? budget : undefined)) },
    });

    const smallBudgetCandidates = (await handleGetPersonalizedMarketCandidates(
      makeCandidatesCtx('small-budget-user', '25') as any
    )) as unknown as any[];
    const largeBudgetCandidates = (await handleGetPersonalizedMarketCandidates(
      makeCandidatesCtx('large-budget-user', '10000') as any
    )) as unknown as any[];

    expect(smallBudgetCandidates.map((c) => c.pairName)).toEqual(['SOL/USDT']);
    expect(largeBudgetCandidates.map((c) => c.pairName).sort()).toEqual(['BTC/USDT', 'SOL/USDT']);
  });

  it('8. guarantees exact numerical and data-quality regression parity against direct baseline MarketOpportunityScanner output', async () => {
    vi.useFakeTimers();
    const frozenNowMs = 1_761_000_000_000;
    vi.setSystemTime(frozenNowMs);

    const { markets, tickers, trendBySymbol } = buildEightSymbolUniverse();
    const frozenCandles = new Map<string, any[]>();
    for (const m of markets) {
      for (const tf of ['4h', '1h', '15m', '5m'] as ScannerTimeframe[]) {
        frozenCandles.set(
          `${m.symbol}:${tf}`,
          generateDeterministicCandles(tf, frozenNowMs, 65, trendBySymbol.get(m.symbol) ?? 'BULL')
        );
      }
    }

    const mockAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockResolvedValue(tickers),
      fetchCandles: vi.fn().mockImplementation(async (sym: string, tf: ScannerTimeframe) => {
        return frozenCandles.get(`${sym}:${tf}`) ?? [];
      }),
    } as unknown as IExchangeProvider & ICandleProvider;

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

    // 1. Direct baseline execution: fresh MarketOpportunityScanner(adapter) with default internal CandleStore
    const baselineScanner = new MarketOpportunityScanner(mockAdapter);
    const baselineScanResult = await baselineScanner.scan({ markets, tickers });
    const baselineFormatted = {
      success: true,
      timestamp: baselineScanResult.timestamp,
      executionDurationMs: baselineScanResult.executionDurationMs,
      universeSize: baselineScanResult.universeSize,
      eligibleCount: baselineScanResult.eligibleCount,
      qualityCount: baselineScanResult.qualityCount,
      screenedCount: baselineScanResult.screenedCount,
      totalOpportunities: baselineScanResult.allQualifiedOpportunities.length,
      opportunities: baselineScanResult.allQualifiedOpportunities,
      telemetry: baselineScanResult.telemetry,
    };

    // 2. Phase 1 route execution: cold scan + cached hit
    const phase1ColdRes = (await handleGetMarketOpportunities(
      createMockContext({ userId: 'parity-user-1' })
    )) as any;
    const phase1WarmRes = (await handleGetMarketOpportunities(
      createMockContext({ userId: 'parity-user-2' })
    )) as any;

    const normBaseline = normalizeVolatileResponseMetadata(baselineFormatted);
    const normPhase1Cold = normalizeVolatileResponseMetadata(phase1ColdRes);
    const normPhase1Warm = normalizeVolatileResponseMetadata(phase1WarmRes);

    // Bit-for-bit equality across all floating-point scores, indicators, regimes, strategies, and dataSanity decisions
    expect(normPhase1Cold).toEqual(normBaseline);
    expect(normPhase1Warm).toEqual(normBaseline);

    // Explicitly assert dataSanity and freshness fields were genuinely evaluated and compared (not stubbed)
    for (let i = 0; i < normBaseline.opportunities.length; i++) {
      expect(normPhase1Cold.opportunities[i].marketQuality.dataSanity).toEqual(
        normBaseline.opportunities[i].marketQuality.dataSanity
      );
      expect(normPhase1Cold.opportunities[i].opportunityScore).toBe(
        normBaseline.opportunities[i].opportunityScore
      );
    }
  });

  it('9. guarantees shared cached results cannot be mutated by individual callers and transient empty-universe responses do not poison cache', async () => {
    const { markets, tickers, trendBySymbol } = buildEightSymbolUniverse();
    let returnEmptyUniverse = true;

    const mockAdapter = {
      fetchMarkets: vi.fn().mockImplementation(async () => (returnEmptyUniverse ? [] : markets)),
      fetchTickers: vi.fn().mockImplementation(async () => (returnEmptyUniverse ? [] : tickers)),
      fetchCandles: vi.fn().mockImplementation(async (sym: string, tf: ScannerTimeframe) =>
        generateDeterministicCandles(tf, Date.now(), 65, trendBySymbol.get(sym) ?? 'BULL')
      ),
    } as unknown as IExchangeProvider & ICandleProvider;

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

    // 1. Transient empty universe returns empty list without poisoning shared cache
    const emptyRes = (await handleGetMarketOpportunities(createMockContext({ userId: 'empty-check' }))) as any;
    expect(emptyRes.success).toBe(true);
    expect(emptyRes.opportunities).toEqual([]);
    expect(__getPublicOpportunityDiagnosticsForTests().sharedCacheKeys).toHaveLength(0);

    // 2. Next request immediately recovers with healthy universe
    returnEmptyUniverse = false;
    const [callerA, callerB] = await Promise.all([
      handleGetMarketOpportunities(createMockContext({ userId: 'mutating-caller-A' })) as Promise<any>,
      handleGetMarketOpportunities(createMockContext({ userId: 'concurrent-caller-B' })) as Promise<any>,
    ]);

    const originalCount = callerB.opportunities.length;
    const originalTopScore = callerB.opportunities[0].opportunityScore;
    const originalFirstSymbol = callerB.opportunities[0].symbol;
    const originalReasonsCount = callerB.opportunities[0].reasons.length;

    // Aggressively mutate callerA's returned payload in place
    callerA.opportunities[0].opportunityScore = -999999;
    callerA.opportunities[0].symbol = 'CORRUPTED/PAIR';
    callerA.opportunities[0].reasons.push('INJECTED_MUTATION');
    callerA.opportunities.pop();
    callerA.telemetry.opportunities = [];

    // Concurrent callerB and subsequent warm-cache callerC remain 100% uncorrupted
    expect(callerB.opportunities).toHaveLength(originalCount);
    expect(callerB.opportunities[0].opportunityScore).toBe(originalTopScore);
    expect(callerB.opportunities[0].symbol).toBe(originalFirstSymbol);
    expect(callerB.opportunities[0].reasons).toHaveLength(originalReasonsCount);

    const callerC = (await handleGetMarketOpportunities(createMockContext({ userId: 'warm-caller-C' }))) as any;
    expect(callerC.opportunities).toHaveLength(originalCount);
    expect(callerC.opportunities[0].opportunityScore).toBe(originalTopScore);
    expect(callerC.opportunities[0].symbol).toBe(originalFirstSymbol);
    expect(callerC.opportunities[0].reasons).toHaveLength(originalReasonsCount);
    expect(callerC.telemetry.opportunities).toHaveLength(originalCount);
  });
});
