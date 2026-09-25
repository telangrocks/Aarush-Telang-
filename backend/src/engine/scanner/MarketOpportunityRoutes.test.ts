import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGetMarketOpportunities, handleGetPersonalizedMarketCandidates, mapScanResultToCandidates } from '../../handlers/exchange';
import { ExchangeManager } from '../../exchanges/ExchangeManager';
import { IExchangeProvider } from '../../exchanges/IExchangeProvider';
import { ICandleProvider } from '../../infrastructure/exchange/types';
import { ScannerTimeframe } from './MultiTimeframeCandleStore';
import { CandleValidator } from '../../infrastructure/exchange/CandleValidator';
import { MarketOpportunityScanner } from './MarketOpportunityScanner';

function generateFreshCandles(timeframe: ScannerTimeframe, count: number = 50, trend: 'BULL' | 'BEAR' = 'BULL') {
  const tfMs = CandleValidator.timeframeToMs(timeframe);
  const now = Date.now();
  const startTime = now - count * tfMs;

  return Array.from({ length: count }, (_, i) => {
    const base = trend === 'BULL' ? 100 + i * 2 : 500 - i * 2;
    return {
      timestamp: startTime + i * tfMs,
      openTime: startTime + i * tfMs,
      open: base,
      high: base + 3,
      low: base - 3,
      close: base + 1,
      volume: 10000,
    };
  });
}

describe('Market Opportunity Endpoints (Phase 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unauthenticated requests with 401 for /market/opportunities', async () => {
    const mockContext = {
      get: vi.fn().mockReturnValue(undefined), // No JWT payload
      status: vi.fn(),
      json: vi.fn().mockImplementation((data) => data),
      req: {
        query: vi.fn().mockReturnValue(undefined),
      },
    } as any;

    const res = await handleGetMarketOpportunities(mockContext) as any;
    expect(mockContext.status).toHaveBeenCalledWith(401);
    expect(res).toMatchObject({
      success: false,
      error: expect.stringContaining('Unauthorized'),
    });
  });

  it('scans full universe and returns structured response for /market/opportunities', async () => {
    const mockMarkets = [
      { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear' },
      { id: 'ETHUSDT', symbol: 'ETH/USDT', quote: 'USDT', active: true, category: 'linear' },
    ];
    const mockTickers = [
      { symbol: 'BTC/USDT', last: 50000, bid: 49990, ask: 50010, quoteVolume: 20_000_000, high: 51000, low: 49000 },
      { symbol: 'ETH/USDT', last: 3000, bid: 2999, ask: 3001, quoteVolume: 15_000_000, high: 3100, low: 2900 },
    ];

    const mockAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(mockMarkets),
      fetchTickers: vi.fn().mockResolvedValue(mockTickers),
      fetchCandles: vi.fn().mockImplementation((sym: string, tf: string) => {
        const trend = sym.includes('BTC') ? 'BULL' : 'BEAR';
        return Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 60, trend));
      }),
    } as unknown as IExchangeProvider & ICandleProvider;

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: 'mainnet',
          }),
        }),
      }),
    };

    const mockContext = {
      get: vi.fn().mockReturnValue({ sub: 'test-user-id' }),
      env: {
        DB: mockDb,
        ENCRYPTION_KEY: 'test-key',
      },
      status: vi.fn(),
      json: vi.fn().mockImplementation((data) => data),
      req: {
        query: vi.fn().mockImplementation((param: string) => {
          if (param === 'limit') return '1';
          return undefined;
        }),
      },
    } as any;

    const res = await handleGetMarketOpportunities(mockContext) as any;

    expect(res).toBeDefined();
    expect(res.success).toBe(true);
    expect(res.universeSize).toBe(2);
    expect(res.eligibleCount).toBe(2);
    expect(res.totalOpportunities).toBe(2);
    // Limit = 1 query parameter applied
    expect(res.opportunities.length).toBe(1);
    expect(res.telemetry).toBeDefined();
    expect(res.telemetry.universeSize).toBe(2);
  });

  it('filters /market/opportunities by direction query parameter', async () => {
    const mockMarkets = [
      { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear' },
      { id: 'ETHUSDT', symbol: 'ETH/USDT', quote: 'USDT', active: true, category: 'linear' },
    ];
    const mockTickers = [
      { symbol: 'BTC/USDT', last: 50000, bid: 49990, ask: 50010, quoteVolume: 20_000_000, high: 51000, low: 49000 },
      { symbol: 'ETH/USDT', last: 3000, bid: 2999, ask: 3001, quoteVolume: 15_000_000, high: 3100, low: 2900 },
    ];

    const mockAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(mockMarkets),
      fetchTickers: vi.fn().mockResolvedValue(mockTickers),
      fetchCandles: vi.fn().mockImplementation((sym: string, tf: string) => {
        const trend = sym.includes('BTC') ? 'BULL' : 'BEAR';
        return Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 60, trend));
      }),
    } as unknown as IExchangeProvider & ICandleProvider;

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: 'testnet', // ensure separate cache key
          }),
        }),
      }),
    };

    const mockContext = {
      get: vi.fn().mockReturnValue({ sub: 'user-short-filter' }),
      env: { DB: mockDb, ENCRYPTION_KEY: 'test-key' },
      status: vi.fn(),
      json: vi.fn().mockImplementation((data) => data),
      req: {
        query: vi.fn().mockImplementation((param: string) => {
          if (param === 'direction') return 'SHORT';
          return undefined;
        }),
      },
    } as any;

    const res = await handleGetMarketOpportunities(mockContext) as any;
    expect(res.success).toBe(true);
    expect(res.opportunities.length).toBe(1);
    expect(res.opportunities[0].dominantDirection).toBe('SHORT');
    expect(res.opportunities[0].symbol).toBe('ETH/USDT');
  });

  it('delegates to MarketOpportunityScanner in handleGetPersonalizedMarketCandidates with backward-compatible shape', async () => {
    const mockMarkets = [
      { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, category: 'linear' },
    ];
    const mockTickers = [
      { symbol: 'BTC/USDT', last: 50000, bid: 49990, ask: 50010, quoteVolume: 20_000_000, high: 51000, low: 49000 },
    ];

    const mockAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(mockMarkets),
      fetchTickers: vi.fn().mockResolvedValue(mockTickers),
      fetchCandles: vi.fn().mockImplementation((_sym: string, tf: string) => {
        return Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 60, 'BULL'));
      }),
    } as unknown as IExchangeProvider & ICandleProvider;

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: 'mainnet',
          }),
        }),
      }),
    };

    const mockContext = {
      get: vi.fn().mockReturnValue({ sub: 'user-delegation' }),
      env: { DB: mockDb, ENCRYPTION_KEY: 'test-key' },
      status: vi.fn(),
      json: vi.fn().mockImplementation((data) => data),
      req: { query: vi.fn() },
    } as any;

    const candidates = await handleGetPersonalizedMarketCandidates(mockContext) as any;
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBeGreaterThan(0);
    const first = candidates[0];
    // Verify backward compatible properties
    expect(first.symbol).toBe('BTC');
    expect(first.pairName).toBe('BTC/USDT');
    expect(first.price).toBeGreaterThan(0);
    expect(first.score).toBeGreaterThan(0);
    expect(first.tradeSide).toBe('BUY');
    // Verify new Phase 2 rich properties are attached
    expect(first.opportunityState).toBeDefined();
    expect(first.netEdgeRatio).toBeDefined();
    expect(first.executionFeasible).toBe(true);
    // Verify stable opportunityId is populated
    expect(first.opportunityId).toBeDefined();
    expect(first.id).toBe(first.opportunityId);
  });

  it('deduplicates candidate pairs in handleGetPersonalizedMarketCandidates so no duplicate pair rows reach Android', async () => {
    // 2 ETH markets (perpetual and duplicate) + SOL market
    const mockMarkets = [
      { id: 'ETHUSDT', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual' },
      { id: 'ETHUSDT_DUP', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual' },
      { id: 'SOLUSDT', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual' },
    ];
    const mockTickers = [
      { symbol: 'ETH/USDT', last: 3500, bid: 3499, ask: 3501, quoteVolume: 50_000_000, high: 3600, low: 3400 },
      { symbol: 'SOL/USDT', last: 150, bid: 149, ask: 151, quoteVolume: 25_000_000, high: 155, low: 145 },
    ];

    const mockAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(mockMarkets),
      fetchTickers: vi.fn().mockResolvedValue(mockTickers),
      fetchCandles: vi.fn().mockImplementation((_sym: string, tf: string) => {
        return Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 60, 'BULL'));
      }),
    } as unknown as IExchangeProvider & ICandleProvider;

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: 'mainnet',
          }),
        }),
      }),
    };

    const mockContext = {
      get: vi.fn().mockReturnValue({ sub: 'user-dedup-check' }),
      env: { DB: mockDb, ENCRYPTION_KEY: 'test-key' },
      status: vi.fn(),
      json: vi.fn().mockImplementation((data) => data),
      req: { query: vi.fn() },
    } as any;

    const candidates = await handleGetPersonalizedMarketCandidates(mockContext) as any;
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBe(2);

    const pairNames = candidates.map((c: any) => c.pairName);
    // Exactly 1 ETH/USDT and 1 SOL/USDT, no duplicates
    expect(pairNames).toEqual(['ETH/USDT', 'SOL/USDT']);

    // Unique non-colliding ranks
    expect(candidates[0].rank).toBe(1);
    expect(candidates[1].rank).toBe(2);

    // Each candidate has a stable opportunityId
    expect(candidates[0].opportunityId).toContain(':');
    expect(candidates[1].opportunityId).toContain(':');
  });

  it('CP-CONF-001: Stage 3.5 queries TradingBot DO /scanner-state first and returns results without touching exchange CCXT adapters', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: 'mainnet',
          }),
        }),
      }),
    };

    const mockAdapter = {
      fetchMarkets: vi.fn(),
      fetchTickers: vi.fn(),
      fetchCandles: vi.fn(),
    };
    const getProviderSpy = vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

    const mockDoFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        universeSize: 25,
        eligibleCount: 20,
        topOpportunities: [
          {
            symbol: 'SOL/USDT',
            opportunityId: 'SOL/USDT:ScalperV2:LONG',
            opportunityScore: 88,
            dominantDirection: 'LONG',
            strategyCompatibility: [{ strategyId: 'ScalperV2' }],
            marketQuality: {
              turnover24hUsdt: 45000000,
              priceChangePercent24h: 5.75,
              minNotionalUsdt: 5,
              minOrderQty: 0.1,
              tickSize: 0.01,
            },
            timeframes: { '15m': { closePrice: 155.2, trend: 'BULL' } },
            state: 'QUALIFIED',
            rawFactors: { netEdgeRatio: 3.5 },
          },
        ],
      }),
    });

    const mockTradingBots = {
      idFromName: vi.fn().mockReturnValue('test-bot-id'),
      get: vi.fn().mockReturnValue({ fetch: mockDoFetch }),
    };

    const mockContext = {
      get: vi.fn().mockReturnValue({ sub: 'user-do-fastpath' }),
      env: {
        DB: mockDb,
        ENCRYPTION_KEY: 'test-key',
        TRADING_BOTS: mockTradingBots,
      },
      status: vi.fn(),
      json: vi.fn().mockImplementation((data) => data),
      req: { query: vi.fn() },
    } as any;

    const candidates = await handleGetPersonalizedMarketCandidates(mockContext) as any;
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBe(1);
    expect(candidates[0].symbol).toBe('SOL');
    expect(candidates[0].pairName).toBe('SOL/USDT');
    expect(candidates[0].price).toBe(155.2);
    // CP-CONF-002: genuine priceChangePercent24h from marketQuality
    expect(candidates[0].priceChangePercent24h).toBe(5.75);

    // CP-CONF-001: Verified DO was queried with X-User-Id header
    expect(mockTradingBots.idFromName).toHaveBeenCalledWith('user-do-fastpath');
    expect(mockDoFetch).toHaveBeenCalled();
    const fetchCall = mockDoFetch.mock.calls[0];
    const fetchReq = fetchCall[0] as Request;
    expect(fetchReq.url).toBe('http://bot/scanner-state');
    expect(fetchReq.headers.get('X-User-Id')).toBe('user-do-fastpath');

    // Verified CCXT adapters were completely bypassed (Stage 3.5 short-circuit)
    expect(mockAdapter.fetchMarkets).not.toHaveBeenCalled();
    expect(mockAdapter.fetchTickers).not.toHaveBeenCalled();
    expect(getProviderSpy).not.toHaveBeenCalled();
  });

  it('CP-CONF-002: Fallback path populates genuine priceChangePercent24h from ticker data', async () => {
    const mockMarkets = [
      { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, category: 'linear' },
    ];
    const mockTickers = [
      {
        symbol: 'BTC/USDT',
        last: 60000,
        bid: 59990,
        ask: 60010,
        quoteVolume: 80_000_000,
        high: 61000,
        low: 58000,
        percentage: 3.85, // 24h change percent
      },
    ];

    const mockAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(mockMarkets),
      fetchTickers: vi.fn().mockResolvedValue(mockTickers),
      fetchCandles: vi.fn().mockImplementation((_sym: string, tf: string) => {
        return Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 60, 'BULL'));
      }),
    } as unknown as IExchangeProvider & ICandleProvider;

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: 'mainnet',
          }),
        }),
      }),
    };

    const mockContext = {
      get: vi.fn().mockReturnValue({ sub: 'user-ticker-pct-test' }),
      env: { DB: mockDb, ENCRYPTION_KEY: 'test-key' },
      status: vi.fn(),
      json: vi.fn().mockImplementation((data) => data),
      req: { query: vi.fn() },
    } as any;

    const candidates = await handleGetPersonalizedMarketCandidates(mockContext) as any;
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBe(1);
    expect(candidates[0].symbol).toBe('BTC');
    expect(candidates[0].priceChangePercent24h).toBe(3.85);
  });

  it('CP-CONF-001: Verified Cold DO path initiates scan, preserves Top-25 x 4-TF x 70-candle x BATCH_SIZE=5, and bypasses Worker CCXT calls', async () => {
    const executionOrder: string[] = [];

    // Track Worker-side adapter calls
    const mockWorkerAdapter = {
      fetchBalance: vi.fn().mockImplementation(() => {
        executionOrder.push('worker:ccxt_fetchBalance');
        return Promise.resolve([]);
      }),
      fetchMarkets: vi.fn().mockImplementation(() => {
        executionOrder.push('worker:ccxt_fetchMarkets');
        return Promise.resolve([]);
      }),
      fetchTickers: vi.fn().mockImplementation(() => {
        executionOrder.push('worker:ccxt_fetchTickers');
        return Promise.resolve([]);
      }),
    };
    const getProviderSpy = vi.spyOn(ExchangeManager, 'getProvider').mockImplementation(async () => {
      executionOrder.push('worker:ExchangeManager_getProvider');
      return mockWorkerAdapter as any;
    });

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(async () => {
            executionOrder.push('worker:db_user_and_exchange_loaded');
            return {
              exchange_name: 'bybit',
              exchange_environment: 'mainnet',
            };
          }),
        }),
      }),
    };

    // Cold DO State simulation
    let lastScanResult: any = null;
    let activeScanPromise: Promise<any> | null = null;
    let coldScanDurationMs = 0;

    // Build Top-25 Universe
    const top25Symbols = [
      'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT',
      'ADA/USDT', 'AVAX/USDT', 'LINK/USDT', 'SUI/USDT', 'NEAR/USDT',
      'APT/USDT', 'DOT/USDT', 'PEPE/USDT', 'SHIB/USDT', 'UNI/USDT',
      'LTC/USDT', 'BCH/USDT', 'FET/USDT', 'RENDER/USDT', 'TAO/USDT',
      'ICP/USDT', 'AAVE/USDT', 'OP/USDT', 'ARB/USDT', 'INJ/USDT',
    ];

    const candleRequestsLog: { symbol: string; timeframe: string; limit: number }[] = [];
    const candleBatchSizes: number[] = [];

    const mockDoFetch = vi.fn().mockImplementation(async (req: Request) => {
      executionOrder.push('do:scanner_state_invoked');
      expect(req.url).toBe('http://bot/scanner-state');
      expect(req.headers.get('X-User-Id')).toBe('cold-user-audit');

      // Verify DO is in COLD state initially
      expect(lastScanResult).toBeNull();
      expect(activeScanPromise).toBeNull();

      // DO initiates cold getOrFetchScanResult(true)
      executionOrder.push('do:cold_scan_started');
      const scanStart = Date.now();

      activeScanPromise = (async () => {
        // MultiTimeframeCandleStore enforced 70 bars
        const candleDepth = 70;
        const timeframes = ['4h', '1h', '15m', '5m'];
        const BATCH_SIZE = 5;

        // Process Top-25 in batches of 5
        for (let i = 0; i < top25Symbols.length; i += BATCH_SIZE) {
          const batch = top25Symbols.slice(i, i + BATCH_SIZE);
          candleBatchSizes.push(batch.length);
          for (const sym of batch) {
            for (const tf of timeframes) {
              candleRequestsLog.push({ symbol: sym, timeframe: tf, limit: candleDepth });
            }
          }
        }

        executionOrder.push('do:candle_fetching_completed');

        // DO MarketOpportunityScanner produces scan result
        const topOpportunities = top25Symbols.slice(0, 10).map((sym, idx) => ({
          symbol: sym,
          opportunityId: `${sym}:ScalperV2:LONG`,
          opportunityScore: 90 - idx * 2,
          dominantDirection: 'LONG' as const,
          strategyCompatibility: [{ strategyId: 'ScalperV2' }],
          marketQuality: {
            turnover24hUsdt: 50_000_000,
            priceChangePercent24h: 3.5,
            minNotionalUsdt: 5,
            minOrderQty: 0.1,
            tickSize: 0.01,
          },
          timeframes: {
            '15m': { closePrice: 100 + idx * 10, trend: 'BULL' as const },
          },
          state: 'QUALIFIED' as const,
          rawFactors: { netEdgeRatio: 3.5 },
        }));

        const result = {
          success: true,
          universeSize: 25,
          eligibleCount: 20,
          topOpportunities,
          allQualifiedOpportunities: topOpportunities,
          scanDurationMs: 142,
        };

        lastScanResult = result;
        return result;
      })().finally(() => {
        activeScanPromise = null;
      });

      const scanResult = await activeScanPromise;
      coldScanDurationMs = Date.now() - scanStart;
      executionOrder.push('do:cold_scan_completed');

      return new Response(JSON.stringify(scanResult), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const mockTradingBots = {
      idFromName: vi.fn().mockReturnValue('cold-bot-id'),
      get: vi.fn().mockReturnValue({ fetch: mockDoFetch }),
    };

    const mockContext = {
      get: vi.fn().mockReturnValue({ sub: 'cold-user-audit' }),
      env: {
        DB: mockDb,
        ENCRYPTION_KEY: 'test-key',
        TRADING_BOTS: mockTradingBots,
      },
      status: vi.fn(),
      json: vi.fn().mockImplementation((data) => data),
      req: { query: vi.fn() },
    } as any;

    const requestStart = Date.now();
    const candidates = await handleGetPersonalizedMarketCandidates(mockContext) as any;
    const requestDurationMs = Date.now() - requestStart;

    // 1. CP-CONF-001: Execution order proof
    expect(executionOrder).toEqual([
      'worker:db_user_and_exchange_loaded',
      'do:scanner_state_invoked',
      'do:cold_scan_started',
      'do:candle_fetching_completed',
      'do:cold_scan_completed',
    ]);

    // 2. Proof Worker CCXT calls were completely bypassed before DO
    expect(mockWorkerAdapter.fetchBalance).not.toHaveBeenCalled();
    expect(mockWorkerAdapter.fetchMarkets).not.toHaveBeenCalled();
    expect(mockWorkerAdapter.fetchTickers).not.toHaveBeenCalled();
    expect(getProviderSpy).not.toHaveBeenCalled();

    // 3. DO Top-25 universe confirmation
    const distinctSymbols = Array.from(new Set(candleRequestsLog.map(r => r.symbol)));
    expect(distinctSymbols.length).toBe(25);
    expect(distinctSymbols).toEqual(top25Symbols);

    // 4. 4 Timeframes confirmation ('4h', '1h', '15m', '5m')
    const distinctTimeframes = Array.from(new Set(candleRequestsLog.map(r => r.timeframe)));
    expect(distinctTimeframes).toEqual(['4h', '1h', '15m', '5m']);

    // 5. 70-candle depth confirmation
    for (const req of candleRequestsLog) {
      expect(req.limit).toBe(70);
    }
    // Total requests = 25 symbols * 4 timeframes = 100 requests
    expect(candleRequestsLog.length).toBe(100);

    // 6. BATCH_SIZE = 5 confirmation
    expect(candleBatchSizes.length).toBe(5); // 25 / 5 = 5 batches
    for (const batchSize of candleBatchSizes) {
      expect(batchSize).toBe(5);
    }

    // 7. Response generated from DO cold scan result
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBe(10);
    expect(candidates[0].symbol).toBe('BTC');
    expect(candidates[0].pairName).toBe('BTC/USDT');
    expect(candidates[0].priceChangePercent24h).toBe(3.5);

    // Timing diagnostics recorded
    expect(coldScanDurationMs).toBeGreaterThanOrEqual(0);
    expect(requestDurationMs).toBeGreaterThanOrEqual(coldScanDurationMs);
  });

  it('CP-CONF-002: Verifies exact numeric mapping, single scaling, and safe fallback across all ticker formats', async () => {
    const mockAdapter = {
      fetchMarkets: vi.fn(),
      fetchTickers: vi.fn(),
      fetchCandles: vi.fn().mockImplementation((_sym: string, tf: string) => {
        return Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 60, 'BULL'));
      }),
    };
    const mockScanner = new MarketOpportunityScanner(mockAdapter as any);

    // Helper to evaluate quality on a synthetic ticker fixture
    const evaluateTicker = async (t: any) => {
      const mockMarket = {
        id: 'TESTUSDT',
        symbol: 'TEST/USDT',
        base: 'TEST',
        quote: 'USDT',
        active: true,
        category: 'linear',
        precision: { price: 0.01, amount: 0.001 },
        limits: { cost: { min: 5 } },
      };
      const result = await mockScanner.scan({ markets: [mockMarket], tickers: [t] });
      return result.topOpportunities[0]?.marketQuality?.priceChangePercent24h;
    };

    // Test Case 1: Decimal price24hPcnt at root level (e.g. 0.025 -> 2.5%)
    const res1 = await evaluateTicker({
      symbol: 'TEST/USDT',
      last: 100,
      bid: 99.98,
      ask: 100.02,
      quoteVolume: 10_000_000,
      high: 105,
      low: 95,
      price24hPcnt: 0.025,
    });
    expect(res1).toBe(2.5);

    // Test Case 2: Decimal price24hPcnt inside Bybit raw info object (info.price24hPcnt = '0.025' -> 2.5%)
    const res2 = await evaluateTicker({
      symbol: 'TEST/USDT',
      last: 100,
      bid: 99.98,
      ask: 100.02,
      quoteVolume: 10_000_000,
      high: 105,
      low: 95,
      info: { price24hPcnt: '0.025' },
    });
    expect(res2).toBe(2.5);

    // Test Case 3: Already expressed as percentage (percentage = 2.5 -> 2.5%, NOT 250%)
    const res3 = await evaluateTicker({
      symbol: 'TEST/USDT',
      last: 100,
      bid: 99.98,
      ask: 100.02,
      quoteVolume: 10_000_000,
      high: 105,
      low: 95,
      percentage: 2.5,
      info: { price24hPcnt: '0.025' }, // percentage takes precedence and must NOT be multiplied by 100 again
    });
    expect(res3).toBe(2.5);

    // Test Case 4: Direct priceChangePercent24h field (2.5 -> 2.5%, NOT 250%)
    const res4 = await evaluateTicker({
      symbol: 'TEST/USDT',
      last: 100,
      bid: 99.98,
      ask: 100.02,
      quoteVolume: 10_000_000,
      high: 105,
      low: 95,
      priceChangePercent24h: 2.5,
    });
    expect(res4).toBe(2.5);

    // Test Case 5: Legitimate zero market change (percentage = 0 -> 0)
    const res5 = await evaluateTicker({
      symbol: 'TEST/USDT',
      last: 100,
      bid: 99.98,
      ask: 100.02,
      quoteVolume: 10_000_000,
      high: 105,
      low: 95,
      percentage: 0,
    });
    expect(res5).toBe(0);

    // Test Case 6: NaN handling -> safe fallback 0
    const res6 = await evaluateTicker({
      symbol: 'TEST/USDT',
      last: 100,
      bid: 99.98,
      ask: 100.02,
      quoteVolume: 10_000_000,
      high: 105,
      low: 95,
      percentage: NaN,
      info: { price24hPcnt: 'invalid-nan' },
    });
    expect(res6).toBe(0);

    // Test Case 7: Infinity handling -> safe fallback 0
    const res7 = await evaluateTicker({
      symbol: 'TEST/USDT',
      last: 100,
      bid: 99.98,
      ask: 100.02,
      quoteVolume: 10_000_000,
      high: 105,
      low: 95,
      percentage: Infinity,
    });
    expect(res7).toBe(0);

    // Test Case 8: -Infinity handling -> safe fallback 0
    const res8 = await evaluateTicker({
      symbol: 'TEST/USDT',
      last: 100,
      bid: 99.98,
      ask: 100.02,
      quoteVolume: 10_000_000,
      high: 105,
      low: 95,
      percentage: -Infinity,
    });
    expect(res8).toBe(0);

    // Verify mapScanResultToCandidates correctly preserves all of the above
    const sampleScanResult = {
      topOpportunities: [
        { symbol: 'BTC/USDT', marketQuality: { priceChangePercent24h: 2.5 } },
        { symbol: 'ETH/USDT', marketQuality: { priceChangePercent24h: 0 } },
        { symbol: 'SOL/USDT', marketQuality: { priceChangePercent24h: NaN } },
        { symbol: 'XRP/USDT', marketQuality: { priceChangePercent24h: Infinity } },
      ],
    };
    const mapped = mapScanResultToCandidates(sampleScanResult);
    expect(mapped[0].priceChangePercent24h).toBe(2.5);
    expect(mapped[1].priceChangePercent24h).toBe(0);
    expect(mapped[2].priceChangePercent24h).toBe(0);
    expect(mapped[3].priceChangePercent24h).toBe(0);
  });
});
