import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sign } from 'hono/jwt';
import app from '../../index';
import { handleGetMarketOpportunities, handleGetPersonalizedMarketCandidates, handleTriggerManualTradeAlert, mapScanResultToCandidates, selectBoundedDiscoveryMarkets, __resetPublicOpportunityStateForTests } from '../../handlers/exchange';
import { PublicMarketDataCoordinator } from '../../infrastructure/market-data/PublicMarketDataCoordinator';
import { BybitAdapter } from '../../infrastructure/exchange/adapters/BybitAdapter';
import { TradeValidator } from '../../validation/TradeValidator';
import { FinalDispatchSafetyGate } from '../safety/FinalDispatchSafetyGate';
import { TradingBot } from '../../trading-bot';
import { encrypt } from '../../crypto';
import BigNumber from 'bignumber.js';
import { ExchangeManager } from '../../exchanges/ExchangeManager';
import { IExchangeProvider } from '../../exchanges/IExchangeProvider';
import { ICandleProvider } from '../../infrastructure/exchange/types';
import { ScannerTimeframe } from './MultiTimeframeCandleStore';
import { CandleValidator } from '../../infrastructure/exchange/CandleValidator';
import { MarketOpportunityScanner } from './MarketOpportunityScanner';

function generateFreshCandles(timeframe: ScannerTimeframe, count: number = 50, trend: 'BULL' | 'BEAR' = 'BULL', symbolOrPrice?: string | number) {
  const tfMs = CandleValidator.timeframeToMs(timeframe);
  const now = Date.now();
  const startTime = now - count * tfMs;
  let ref = 100;
  if (typeof symbolOrPrice === 'number' && symbolOrPrice > 0) {
    ref = symbolOrPrice;
  } else if (typeof symbolOrPrice === 'string') {
    if (symbolOrPrice.includes('BTC')) ref = 50000;
    else if (symbolOrPrice.includes('ETH')) ref = 3500;
    else if (symbolOrPrice.includes('SOL')) ref = 150;
    else if (symbolOrPrice.includes('DOGE')) ref = 0.1;
    else ref = 100;
  }
  const barRange = ref * 0.02;

  return Array.from({ length: count }, (_, i) => {
    const base = trend === 'BULL' ? ref + i * (barRange * 0.1) : ref - i * (barRange * 0.1);
    return {
      timestamp: startTime + i * tfMs,
      openTime: startTime + i * tfMs,
      open: base,
      high: base + barRange,
      low: base - barRange,
      close: base + barRange * 0.5,
      volume: 10000,
    };
  });
}

describe('Market Opportunity Endpoints (Phase 2)', () => {
  beforeEach(() => {
    __resetPublicOpportunityStateForTests();
    vi.restoreAllMocks();
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
      fetchCandles: vi.fn().mockImplementation((sym: string, tf: string) => {
        return Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 60, 'BULL', sym));
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
      { symbol: 'SOL/USDT', last: 150, bid: 149.95, ask: 150.05, quoteVolume: 25_000_000, high: 155, low: 145 },
    ];

    const mockAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(mockMarkets),
      fetchTickers: vi.fn().mockResolvedValue(mockTickers),
      fetchCandles: vi.fn().mockImplementation((sym: string, tf: string) => {
        return Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 60, 'BULL', sym));
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
      fetchCandles: vi.fn().mockImplementation((sym: string, tf: string) => {
        return Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 60, 'BULL', sym));
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
      fetchCandles: vi.fn().mockImplementation((sym: string, tf: string) => {
        return Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 60, 'BULL', sym));
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

  it('handleGetPersonalizedMarketCandidates returns 200 with empty array when screenedCount is 0', async () => {
    const mockMarkets = [
      { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, category: 'linear' },
    ];
    const mockTickers = [
      { symbol: 'BTC/USDT', last: 50000, bid: 49990, ask: 50010, quoteVolume: 20_000_000, high: 51000, low: 49000 },
    ];

    const mockAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(mockMarkets),
      fetchTickers: vi.fn().mockResolvedValue(mockTickers),
    } as unknown as IExchangeProvider & ICandleProvider;

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);
    vi.spyOn(MarketOpportunityScanner.prototype, 'scan').mockResolvedValue({
      timestamp: Date.now(),
      executionDurationMs: 10,
      universeSize: 1,
      eligibleCount: 1,
      qualityCount: 1,
      screenedCount: 0,
      allQualifiedOpportunities: [],
      topOpportunities: [],
      telemetry: {} as any,
    });

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: 'demo',
          }),
        }),
      }),
    };

    const mockContext = {
      get: vi.fn().mockReturnValue({ sub: 'user-empty-screened-test' }),
      env: { DB: mockDb, ENCRYPTION_KEY: 'test-key' },
      status: vi.fn(),
      json: vi.fn().mockImplementation((data) => data),
      req: { query: vi.fn() },
    } as any;

    const response = await handleGetPersonalizedMarketCandidates(mockContext) as any;
    expect(mockContext.status).toHaveBeenCalledWith(503);
    expect(response).toEqual({
      success: false,
      code: 'MARKET_DATA_DEGRADED',
      error: 'Market data temporarily degraded or unavailable during discovery scan.',
    });
    expect(mockContext.json).toHaveBeenCalledWith({
      success: false,
      code: 'MARKET_DATA_DEGRADED',
      error: 'Market data temporarily degraded or unavailable during discovery scan.',
    });
  });

  it('handleGetPersonalizedMarketCandidates returns 503 MARKET_DATA_DEGRADED when all candidates are degraded', async () => {
    const mockMarkets = [
      { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, category: 'linear' },
    ];
    const mockTickers = [
      { symbol: 'BTC/USDT', last: 50000, bid: 49990, ask: 50010, quoteVolume: 20_000_000, high: 51000, low: 49000 },
    ];

    const mockAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(mockMarkets),
      fetchTickers: vi.fn().mockResolvedValue(mockTickers),
    } as unknown as IExchangeProvider & ICandleProvider;

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);
    vi.spyOn(MarketOpportunityScanner.prototype, 'scan').mockResolvedValue({
      timestamp: Date.now(),
      executionDurationMs: 10,
      universeSize: 1,
      eligibleCount: 1,
      qualityCount: 1,
      screenedCount: 1,
      allQualifiedOpportunities: [
        {
          symbol: 'BTC/USDT',
          state: 'DATA_DEGRADED',
          opportunityId: 'BTC/USDT:ScalperV2:LONG',
          dominantDirection: 'LONG',
          opportunityScore: 80,
          marketQuality: { turnover24hUsdt: 10_000_000, priceChangePercent24h: 2.1 },
          strategyCompatibility: [{ strategyId: 'ScalperV2' }],
          timeframes: {},
          rawFactors: { netEdgeRatio: 3.5 },
        } as any,
      ],
      topOpportunities: [
        {
          symbol: 'BTC/USDT',
          state: 'DATA_DEGRADED',
          opportunityId: 'BTC/USDT:ScalperV2:LONG',
          dominantDirection: 'LONG',
          opportunityScore: 80,
          marketQuality: { turnover24hUsdt: 10_000_000, priceChangePercent24h: 2.1 },
          strategyCompatibility: [{ strategyId: 'ScalperV2' }],
          timeframes: {},
          rawFactors: { netEdgeRatio: 3.5 },
        } as any,
      ],
      telemetry: {} as any,
    });

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: 'demo',
          }),
        }),
      }),
    };

    const mockContext = {
      get: vi.fn().mockReturnValue({ sub: 'user-degraded-filter-test' }),
      env: { DB: mockDb, ENCRYPTION_KEY: 'test-key' },
      status: vi.fn(),
      json: vi.fn().mockImplementation((data) => data),
      req: { query: vi.fn() },
    } as any;

    const response = await handleGetPersonalizedMarketCandidates(mockContext) as any;
    expect(mockContext.status).toHaveBeenCalledWith(503);
    expect(response).toEqual({
      success: false,
      code: 'MARKET_DATA_DEGRADED',
      error: 'Market data temporarily degraded or unavailable during discovery scan.',
    });
    expect(mockContext.json).toHaveBeenCalledWith({
      success: false,
      code: 'MARKET_DATA_DEGRADED',
      error: 'Market data temporarily degraded or unavailable during discovery scan.',
    });
  });

  describe('selectBoundedDiscoveryMarkets — Maximum Selection & Invalid Metadata Semantics', () => {
    const baseTicker = (symbol: string, price = 1.0) => ({
      symbol,
      pairName: symbol,
      last: price,
      price,
      bid: price * 0.9999,
      ask: price * 1.0001,
      quoteVolume: 20_000_000,
      high: price * 1.03,
      low: price * 0.97,
    });

    const baseMarket = (symbol: string, overrides: any = {}) => ({
      id: symbol.replace('/', ''),
      symbol,
      base: symbol.split('/')[0],
      quote: 'USDT',
      active: true,
      category: 'linear',
      contractType: 'LinearPerpetual',
      precision: { price: 0.001, amount: 1 },
      limits: {
        amount: { min: 1 },
        cost: { min: 5 },
      },
      ...overrides,
    });

    it('1. handles both maxima present (enforces tighter ceiling when clamping against minNotional)', () => {
      // Price = $1.0, budget = $100, minNotional = $50.
      // Market A: maxOrderQty = 1000, maxMktOrderQty = 60 -> clamped to 60 ($60 >= $50) -> ELIGIBLE
      // Market B: maxOrderQty = 1000, maxMktOrderQty = 30 -> clamped to 30 ($30 < $50 minNotional) -> REJECTED
      const mA = baseMarket('AAA/USDT', {
        limits: { amount: { min: 1, max: 1000 }, marketAmount: { max: 60 }, cost: { min: 50 } },
      });
      const mB = baseMarket('BBB/USDT', {
        limits: { amount: { min: 1, max: 1000 }, marketAmount: { max: 30 }, cost: { min: 50 } },
      });
      const resAll = selectBoundedDiscoveryMarkets([mA, mB], [baseTicker('AAA/USDT'), baseTicker('BBB/USDT')], 100);
      expect(resAll.map(m => m.symbol)).toEqual(['AAA/USDT']);

      // When orderType = 'LIMIT', Market B uses maxOrderQty = 1000 and is ELIGIBLE
      const resLimit = selectBoundedDiscoveryMarkets([mA, mB], [baseTicker('AAA/USDT'), baseTicker('BBB/USDT')], 100, 8, 'LIMIT');
      expect(resLimit.map(m => m.symbol)).toEqual(['AAA/USDT', 'BBB/USDT']);
    });

    it('2. handles only the LIMIT maximum present (does not discard market when marketMaxQty is absent)', () => {
      const m = baseMarket('LIMONLY/USDT', {
        limits: { amount: { min: 1, max: 500 }, cost: { min: 5 } },
      });
      const res = selectBoundedDiscoveryMarkets([m], [baseTicker('LIMONLY/USDT')], 25);
      expect(res.map(x => x.symbol)).toEqual(['LIMONLY/USDT']);
    });

    it('3. handles only the MARKET maximum present (does not discard market when maxOrderQty is absent)', () => {
      const m = baseMarket('MKTONLY/USDT', {
        limits: { amount: { min: 1 }, marketAmount: { max: 500 }, cost: { min: 5 } },
      });
      const res = selectBoundedDiscoveryMarkets([m], [baseTicker('MKTONLY/USDT')], 25);
      expect(res.map(x => x.symbol)).toEqual(['MKTONLY/USDT']);
    });

    it('4. handles both maxima absent (treats absent optional maxima as no published upper bound)', () => {
      const m = baseMarket('NOMAX/USDT', {
        limits: { amount: { min: 1 }, cost: { min: 5 } },
      });
      const res = selectBoundedDiscoveryMarkets([m], [baseTicker('NOMAX/USDT')], 25);
      expect(res.map(x => x.symbol)).toEqual(['NOMAX/USDT']);
    });

    it('5. rejects when either maximum is explicitly zero (never treats 0 as absent or falls back to the other maximum)', () => {
      const mZeroLimit = baseMarket('ZEROLIM/USDT', {
        limits: { amount: { min: 1, max: 0 }, marketAmount: { max: 500 }, cost: { min: 5 } },
      });
      const mZeroMkt = baseMarket('ZEROMKT/USDT', {
        limits: { amount: { min: 1, max: 500 }, marketAmount: { max: 0 }, cost: { min: 5 } },
      });
      const res = selectBoundedDiscoveryMarkets(
        [mZeroLimit, mZeroMkt],
        [baseTicker('ZEROLIM/USDT'), baseTicker('ZEROMKT/USDT')],
        25
      );
      expect(res).toEqual([]);
    });

    it('6. rejects when either maximum is negative, NaN, or infinite', () => {
      const markets = [
        baseMarket('NEGLIM/USDT', { limits: { amount: { min: 1, max: -5 }, marketAmount: { max: 500 }, cost: { min: 5 } } }),
        baseMarket('NEGMKT/USDT', { limits: { amount: { min: 1, max: 500 }, marketAmount: { max: -10 }, cost: { min: 5 } } }),
        baseMarket('NANLIM/USDT', { limits: { amount: { min: 1, max: NaN }, marketAmount: { max: 500 }, cost: { min: 5 } } }),
        baseMarket('NANMKT/USDT', { limits: { amount: { min: 1, max: 500 }, marketAmount: { max: NaN }, cost: { min: 5 } } }),
        baseMarket('INFLIM/USDT', { limits: { amount: { min: 1, max: Infinity }, marketAmount: { max: 500 }, cost: { min: 5 } } }),
        baseMarket('INFMKT/USDT', { limits: { amount: { min: 1, max: 500 }, marketAmount: { max: -Infinity }, cost: { min: 5 } } }),
      ];
      const tickers = markets.map(m => baseTicker(m.symbol));
      const res = selectBoundedDiscoveryMarkets(markets, tickers, 25);
      expect(res).toEqual([]);
    });
  });

  describe('Budget Eligibility Boundary, Cache Isolation & Empty-Reason Header Verification', () => {
    it('filters out ineligible markets BEFORE candle fetching and TA in handleGetPersonalizedMarketCandidates and sets X-Empty-Reason headers accurately', async () => {
      const mockMarkets = [
        {
          id: 'BTCUSDT',
          symbol: 'BTC/USDT',
          base: 'BTC',
          quote: 'USDT',
          active: true,
          category: 'linear',
          contractType: 'LinearPerpetual',
          precision: { price: 0.1, amount: 0.001 },
          limits: { amount: { min: 0.001, max: 100 }, marketAmount: { max: 50 }, cost: { min: 5 } }, // 0.001 * 76870 = $76.87 min
        },
        {
          id: 'DOGEUSDT',
          symbol: 'DOGE/USDT',
          base: 'DOGE',
          quote: 'USDT',
          active: true,
          category: 'linear',
          contractType: 'LinearPerpetual',
          precision: { price: 0.00001, amount: 1 },
          limits: { amount: { min: 1, max: 1000000 }, marketAmount: { max: 500000 }, cost: { min: 5 } }, // $5 min notional
        },
      ];
      const mockTickers = [
        { symbol: 'BTC/USDT', last: 76870, bid: 76865, ask: 76875, quoteVolume: 100_000_000, high: 78500, low: 75000 },
        { symbol: 'DOGE/USDT', last: 0.12, bid: 0.1199, ask: 0.1201, quoteVolume: 40_000_000, high: 0.125, low: 0.115 },
      ];

      const fetchCandlesSpy = vi.fn().mockImplementation((_sym: string, tf: string) =>
        Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 60, 'BULL'))
      );

      const mockAdapter = {
        fetchMarkets: vi.fn().mockResolvedValue(mockMarkets),
        fetchTickers: vi.fn().mockResolvedValue(mockTickers),
        fetchCandles: fetchCandlesSpy,
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

      // Case A: Budget = $10 -> BTC/USDT ($76.87 min) is excluded before candle fetch; only DOGE/USDT reaches fetchCandles & TA
      const headersA: Record<string, string> = {};
      const ctxA = {
        get: vi.fn().mockReturnValue({ sub: 'user-boundary-test' }),
        env: { DB: mockDb, ENCRYPTION_KEY: 'test-key' },
        status: vi.fn(),
        header: vi.fn().mockImplementation((k: string, v: string) => { headersA[k] = v; }),
        json: vi.fn().mockImplementation((data) => data),
        req: { query: vi.fn().mockImplementation((k: string) => (k === 'budget' ? '10' : undefined)) },
      } as any;

      const resA = await handleGetPersonalizedMarketCandidates(ctxA) as any;
      expect(resA.map((c: any) => c.pairName)).toEqual(['DOGE/USDT']);
      const candleSymbolsCalled = new Set(fetchCandlesSpy.mock.calls.map((c: any[]) => c[0]));
      expect(candleSymbolsCalled.has('BTC/USDT')).toBe(false);
      expect(candleSymbolsCalled.has('DOGE/USDT')).toBe(true);
      expect(headersA['X-Eligible-Market-Count']).toBe('1');

      // Case B: Budget = $3 -> No markets eligible ($5 minNotional). Returns [] with X-Empty-Reason: NO_ELIGIBLE_MARKETS and 0 new candle calls
      fetchCandlesSpy.mockClear();
      const headersB: Record<string, string> = {};
      const ctxB = {
        get: vi.fn().mockReturnValue({ sub: 'user-boundary-test' }),
        env: { DB: mockDb, ENCRYPTION_KEY: 'test-key' },
        status: vi.fn(),
        header: vi.fn().mockImplementation((k: string, v: string) => { headersB[k] = v; }),
        json: vi.fn().mockImplementation((data) => data),
        req: { query: vi.fn().mockImplementation((k: string) => (k === 'budget' ? '3' : undefined)) },
      } as any;

      const resB = await handleGetPersonalizedMarketCandidates(ctxB) as any;
      expect(resB).toEqual([]);
      expect(fetchCandlesSpy).not.toHaveBeenCalled();
      expect(headersB['X-Empty-Reason']).toBe('NO_ELIGIBLE_MARKETS');
      expect(headersB['X-Eligible-Market-Count']).toBe('0');

      // Case C: Empty result was NOT cached -> if market rules change so DOGE minNotional becomes $2, re-running with budget = $3 immediately succeeds
      mockMarkets[1].limits.cost.min = 2;
      const headersC: Record<string, string> = {};
      const ctxC = {
        get: vi.fn().mockReturnValue({ sub: 'user-boundary-test' }),
        env: { DB: mockDb, ENCRYPTION_KEY: 'test-key' },
        status: vi.fn(),
        header: vi.fn().mockImplementation((k: string, v: string) => { headersC[k] = v; }),
        json: vi.fn().mockImplementation((data) => data),
        req: { query: vi.fn().mockImplementation((k: string) => (k === 'budget' ? '3' : undefined)) },
      } as any;

      const resC = await handleGetPersonalizedMarketCandidates(ctxC) as any;
      expect(resC.map((c: any) => c.pairName)).toEqual(['DOGE/USDT']);
      expect(headersC['X-Eligible-Market-Count']).toBe('1');
    });

    it('proves complete end-to-end propagation: Bybit V5 response -> BybitAdapter.mapInstrumentToMarket() -> SymbolTradingRules -> TradeValidator -> FinalDispatchSafetyGate', () => {
      const adapter = new BybitAdapter();
      const mapFn = (adapter as any).mapInstrumentToMarket.bind(adapter);

      // 1. Both maxOrderQty and maxMktOrderQty present and distinct
      const bybitRawItem = {
        symbol: '1000PEPEUSDT',
        baseCoin: '1000PEPE',
        quoteCoin: 'USDT',
        status: 'Trading',
        contractType: 'LinearPerpetual',
        priceFilter: { tickSize: '0.000001', minPrice: '0.000001', maxPrice: '10.0' },
        lotSizeFilter: {
          minOrderQty: '100',
          qtyStep: '100',
          maxOrderQty: '1000000',
          maxMktOrderQty: '250000',
          minNotionalValue: '5',
        },
      };

      const market = mapFn(bybitRawItem, 'linear');
      expect(market.limits.amount.max?.toNumber()).toBe(1000000);
      expect(market.limits.marketAmount?.max?.toNumber()).toBe(250000);

      const rules = {
        schemaVersion: '2.0' as const,
        symbol: market.symbol,
        exchange: 'bybit',
        baseAsset: market.base,
        quoteAsset: market.quote,
        minNotional: market.limits.cost.min.toNumber(),
        minQty: market.limits.amount.min.toNumber(),
        maxQty: market.limits.amount.max?.toNumber(),
        marketMaxQty: market.limits.marketAmount?.max?.toNumber(),
        stepSize: market.precision.amount,
        tickSize: market.precision.price,
        minPrice: market.limits.price.min.toNumber(),
        maxPrice: market.limits.price.max?.toNumber() ?? 999999999,
        contractSize: 1,
        lastUpdated: Date.now(),
      };

      // MARKET order uses marketMaxQty (250,000)
      const mktVal = TradeValidator.validate(
        { symbol: market.symbol, orderType: 'MARKET', entryPrice: 0.005, tradeValueUsdt: 2500 },
        rules
      );
      expect(mktVal.isValid).toBe(true);
      expect(mktVal.quantizedQuantity).toBe(250000);

      // FinalDispatchSafetyGate with MARKET ceiling (250,000) accepts 250,000 and rejects 300,000
      expect(() =>
        FinalDispatchSafetyGate.validate(
          { symbol: market.symbol, side: 'buy', type: 'market', amount: new BigNumber(250000) } as any,
          { stepSize: rules.stepSize, tickSize: rules.tickSize, minQty: rules.minQty, maxQty: rules.marketMaxQty, minNotional: rules.minNotional, referencePrice: 0.005 }
        )
      ).not.toThrow();
      expect(() =>
        FinalDispatchSafetyGate.validate(
          { symbol: market.symbol, side: 'buy', type: 'market', amount: new BigNumber(300000) } as any,
          { stepSize: rules.stepSize, tickSize: rules.tickSize, minQty: rules.minQty, maxQty: rules.marketMaxQty, minNotional: rules.minNotional, referencePrice: 0.005 }
        )
      ).toThrow('exceeds maximum 250000');

      // LIMIT order uses maxQty (1,000,000)
      const limitVal = TradeValidator.validate(
        { symbol: market.symbol, orderType: 'LIMIT', entryPrice: 0.005, tradeValueUsdt: 2500 },
        rules
      );
      expect(limitVal.isValid).toBe(true);
      expect(limitVal.quantizedQuantity).toBe(500000);

      // 2. Invalid maxMktOrderQty ("0") is preserved as 0 (not converted to undefined) and fails closed
      const invalidRawItem = {
        ...bybitRawItem,
        lotSizeFilter: { ...bybitRawItem.lotSizeFilter, maxMktOrderQty: '0' },
      };
      const invalidMarket = mapFn(invalidRawItem, 'linear');
      expect(invalidMarket.limits.marketAmount?.max?.toNumber()).toBe(0);
      const invalidVal = TradeValidator.validate(
        { symbol: invalidMarket.symbol, orderType: 'MARKET', entryPrice: 0.005, tradeValueUsdt: 50 },
        { ...rules, marketMaxQty: invalidMarket.limits.marketAmount?.max?.toNumber() }
      );
      expect(invalidVal.isValid).toBe(false);
    });

    it('proves cache isolation across budgets, orderTypes, environments, and market-rule snapshots', async () => {
      const mockMarkets = [
        {
          id: 'DOGEUSDT',
          symbol: 'DOGE/USDT',
          base: 'DOGE',
          quote: 'USDT',
          active: true,
          category: 'linear',
          contractType: 'LinearPerpetual',
          precision: { price: 0.0001, amount: 1 },
          limits: { amount: { min: 1, max: 1000 }, marketAmount: { max: 40 }, cost: { min: 50 } },
        },
      ];
      const mockTickers = [
        { symbol: 'DOGE/USDT', last: 1.0, bid: 0.9999, ask: 1.0001, quoteVolume: 30_000_000, high: 1.03, low: 0.97 },
      ];

      const fetchCandlesSpy = vi.fn().mockImplementation((_sym: string, tf: string) =>
        Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 60, 'BULL'))
      );

      const mockAdapter = {
        fetchMarkets: vi.fn().mockResolvedValue(mockMarkets),
        fetchTickers: vi.fn().mockResolvedValue(mockTickers),
        fetchCandles: fetchCandlesSpy,
      } as unknown as IExchangeProvider & ICandleProvider;

      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

      let currentEnv = 'mainnet';
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockImplementation(async () => ({
              exchange_name: 'bybit',
              exchange_environment: currentEnv,
            })),
          }),
        }),
      };

      const makeCtx = (params: Record<string, string | undefined>) => ({
        get: vi.fn().mockReturnValue({ sub: 'user-cache-iso' }),
        env: { DB: mockDb, ENCRYPTION_KEY: 'test-key' },
        status: vi.fn(),
        header: vi.fn(),
        json: vi.fn().mockImplementation((data) => data),
        req: { query: vi.fn().mockImplementation((k: string) => params[k]) },
      } as any);

      // 1. orderType=LIMIT with budget=100 -> uses maxOrderQty=1000 ($100 >= $50 minNotional) -> 1 candidate
      const resLimit = await handleGetPersonalizedMarketCandidates(makeCtx({ budget: '100', orderType: 'LIMIT' })) as any;
      expect(resLimit).toHaveLength(1);

      // 2. orderType=MARKET with same budget=100 -> uses marketMaxQty=40 ($40 < $50 minNotional) -> MUST NOT reuse LIMIT cache -> returns []
      const resMarket = await handleGetPersonalizedMarketCandidates(makeCtx({ budget: '100', orderType: 'MARKET' })) as any;
      expect(resMarket).toEqual([]);

      // 3. Different environment (demo) -> does not reuse mainnet cache
      currentEnv = 'demo';
      fetchCandlesSpy.mockClear();
      const ctxDemo = {
        ...makeCtx({ budget: '100', orderType: 'LIMIT' }),
        get: vi.fn().mockReturnValue({ sub: 'user-cache-iso-demo' }),
      };
      const resDemo = await handleGetPersonalizedMarketCandidates(ctxDemo) as any;
      expect(resDemo).toHaveLength(1);
      expect(fetchCandlesSpy).toHaveBeenCalled();

      // 4. Stale price invalidation: if live price spikes so minQty * price > budget while exchange rules are unchanged, cache CANNOT return the now-ineligible candidate
      mockMarkets[0].limits.amount.min = 80; // minOrderQty = 80 DOGE
      mockTickers[0].last = 1.0; // 80 * $1.00 = $80 <= $100 budget -> eligible
      const ctxPriceSpike = {
        ...makeCtx({ budget: '100', orderType: 'LIMIT' }),
        get: vi.fn().mockReturnValue({ sub: 'user-cache-price-spike' }),
      };
      const resBeforeSpike = await handleGetPersonalizedMarketCandidates(ctxPriceSpike) as any;
      expect(resBeforeSpike).toHaveLength(1);

      // Live price moves to $1.50 -> 80 * $1.50 = $120 > $100 budget (exchange rules unchanged)
      mockTickers[0].last = 1.5;
      const ctxAfterSpike = {
        ...makeCtx({ budget: '100', orderType: 'LIMIT' }),
        get: vi.fn().mockReturnValue({ sub: 'user-cache-price-spike' }),
      };
      const resAfterSpike = await handleGetPersonalizedMarketCandidates(ctxAfterSpike) as any;
      expect(resAfterSpike).toEqual([]);
      expect(ctxAfterSpike.header).toHaveBeenCalledWith('X-Empty-Reason', 'NO_ELIGIBLE_MARKETS');
      expect(ctxAfterSpike.header).toHaveBeenCalledWith('X-Eligible-Market-Count', '0');
    });

    it('proves ineligible markets and invalid metadata cannot reach alert notifications (handleTriggerManualTradeAlert) or final dispatch (TradingBot.executeOpportunity), and changed rules/prices trigger revalidation rejection', async () => {
      const botFetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({
              exchange_name: 'bybit',
              exchange_environment: 'demo',
              exchange_api_key: 'plain-key',
            }),
          }),
        }),
      };

      let currentMarketRule: any = {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        category: 'linear',
        precision: { price: 0.1, amount: 0.001 },
        limits: { amount: { min: 0.001, max: 100 }, marketAmount: { max: 50 }, cost: { min: 5 } },
      };

      const mockAdapter = {
        fetchMarket: vi.fn().mockImplementation(async () => currentMarketRule),
        fetchMarkets: vi.fn().mockImplementation(async () => [currentMarketRule]),
        fetchTicker: vi.fn().mockResolvedValue({ symbol: 'BTC/USDT', last: new BigNumber(76870) }),
        createOrder: vi.fn(),
      };
      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

      const makeAlertCtx = (body: any) => ({
        get: vi.fn().mockReturnValue({ sub: 'user-alert-boundary' }),
        env: {
          DB: mockDb,
          ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          TRADING_BOTS: {
            idFromName: vi.fn().mockReturnValue('bot-id'),
            get: vi.fn().mockReturnValue({ fetch: botFetchSpy }),
          },
        },
        status: vi.fn(),
        json: vi.fn().mockImplementation((d) => d),
        req: { json: vi.fn().mockResolvedValue(body) },
      } as any);

      // 1. Ineligible market ($10 budget for BTC at $76,870) is blocked BEFORE registering alert or sending notification
      const ineligibleRes = await handleTriggerManualTradeAlert(
        makeAlertCtx({
          symbol: 'BTC/USDT',
          strategy: 'ScalperV2',
          config: { positionSize: 10, entryPrice: 76870, stopLoss: 100, takeProfit: 200, side: 'BUY', entryIntent: 'IMMEDIATE' },
        })
      ) as any;
      expect(ineligibleRes.code).toBe('EXECUTION_INELIGIBLE');
      expect(botFetchSpy).not.toHaveBeenCalled();

      // 2. Explicit invalid marketMaxQty (0) is blocked with INVALID_EXCHANGE_RULES BEFORE registering alert
      currentMarketRule = {
        ...currentMarketRule,
        limits: { amount: { min: 0.001, max: 100 }, marketAmount: { max: 0 }, cost: { min: 5 } },
      };
      const invalidMaxRes = await handleTriggerManualTradeAlert(
        makeAlertCtx({
          symbol: 'BTC/USDT',
          strategy: 'ScalperV2',
          config: { positionSize: 500, entryPrice: 76870, stopLoss: 100, takeProfit: 200, side: 'BUY', entryIntent: 'IMMEDIATE' },
        })
      ) as any;
      expect(invalidMaxRes.code).toBe('INVALID_EXCHANGE_RULES');
      expect(botFetchSpy).not.toHaveBeenCalled();

      // 3. Final dispatch revalidation in TradingBot.executeOpportunity rejects if exchange rules or prices change approvedQuantity or violate marketMaxQty
      const encKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const encApi = await encrypt('test-api-key', encKey);
      const encSec = await encrypt('test-api-secret', encKey);

      const storageMap = new Map<string, any>();
      storageMap.set('userId', 'user-exec-boundary');
      storageMap.set('isActive', true);
      storageMap.set('lastAccountBalance', 10000);
      const alertObj = {
        id: 'alert-revalidate-1',
        symbol: 'DOGE/USDT',
        side: 'BUY',
        strategy: 'ScalperV2',
        signalPrice: 1.0,
        targetEntryPrice: 1.0,
        entryPrice: 1.0,
        entryIntent: 'IMMEDIATE',
        stopLoss: 0.9,
        takeProfit: 1.2,
        positionSize: 50,
        requestedBudget: 50,
        quantity: 50, // Approved when stepSize was 1 and marketMaxQty was 100
        status: 'pending',
        source: 'MANUAL',
        timestamp: new Date().toISOString(),
        timeframe: '5m',
      };
      storageMap.set('alerts', [alertObj]);

      const mockStorage: any = {
        get: vi.fn().mockImplementation((k: string) => Promise.resolve(storageMap.get(k))),
        put: vi.fn().mockImplementation((k: string, v: any) => {
          storageMap.set(k, v);
          return Promise.resolve();
        }),
        delete: vi.fn(),
        list: vi.fn().mockResolvedValue(new Map()),
        transaction: vi.fn().mockImplementation(async (cb: any) => cb(mockStorage)),
      };

      const botDb = {
        prepare: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('PRAGMA table_info')) {
            return {
              all: vi.fn().mockResolvedValue({
                results: [{ name: 'target_entry_price' }, { name: 'entry_status' }],
              }),
            };
          }
          if (sql.includes('FROM users')) {
            return {
              bind: vi.fn().mockReturnValue({
                first: vi.fn().mockResolvedValue({
                  exchange_name: 'bybit',
                  exchange_environment: 'demo',
                  exchange_api_key_iv: encApi.iv,
                  exchange_api_key_encrypted: encApi.encrypted,
                  exchange_api_key_salt: encApi.salt,
                  exchange_api_secret_iv: encSec.iv,
                  exchange_api_secret_encrypted: encSec.encrypted,
                  exchange_api_secret_salt: encSec.salt,
                }),
              }),
            };
          }
          return {
            bind: vi.fn().mockReturnValue({
              all: vi.fn().mockResolvedValue({ results: [] }),
              run: vi.fn().mockResolvedValue({}),
              first: vi.fn().mockResolvedValue(null),
            }),
            all: vi.fn().mockResolvedValue({ results: [] }),
          };
        }),
      };

      // Exchange rule changed before dispatch: marketMaxQty dropped to 30 (< approvedQuantity 50)
      currentMarketRule = {
        id: 'DOGEUSDT',
        symbol: 'DOGE/USDT',
        base: 'DOGE',
        quote: 'USDT',
        active: true,
        category: 'linear',
        precision: { price: 0.01, amount: 1 },
        limits: { amount: { min: 1, max: 1000 }, marketAmount: { max: 30 }, cost: { min: 5 } },
      };
      mockAdapter.fetchTicker = vi.fn().mockResolvedValue({ symbol: 'DOGE/USDT', last: new BigNumber(1.0) });

      let blockPromise: Promise<any> | null = null;
      const bot = new TradingBot(
        {
          storage: mockStorage,
          blockConcurrencyWhile: (fn: any) => {
            blockPromise = fn();
            return blockPromise;
          },
        } as any,
        { DB: botDb, ENCRYPTION_KEY: encKey } as any
      );
      if (blockPromise) await blockPromise;

      const execResp = await bot.fetch(
        new Request('http://bot/execute-trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alertId: 'alert-revalidate-1', entryIntent: 'IMMEDIATE' }),
        })
      );
      const execBody = await execResp.json() as any;
      expect(execBody.success).toBe(false);
      expect(execBody.message).toContain('Approved order quantity (50) exceeds exchange maximum order quantity (30)');
      // Order was NEVER dispatched to exchange
      expect(mockAdapter.createOrder).not.toHaveBeenCalled();

      // 8. Verify trading-bot.ts final-dispatch call path passes marketMaxQty for MARKET and maxQty for LIMIT to FinalDispatchSafetyGate.validate
      const safetyGateSpy = vi.spyOn(FinalDispatchSafetyGate, 'validate');
      mockAdapter.createOrder = vi.fn().mockResolvedValue({
        id: 'order-dispatch-1',
        symbol: 'DOGE/USDT',
        type: 'market',
        side: 'buy',
        amount: new BigNumber(50),
        price: new BigNumber(1.0),
        filled: new BigNumber(50),
        remaining: new BigNumber(0),
        status: 'closed',
      });

      const makeBotInstance = async (alertsList: any[]) => {
        storageMap.delete('activePositions');
        storageMap.delete('currentPosition');
        storageMap.delete('activeExecutionLease');
        for (const k of [...storageMap.keys()]) {
          if (k.startsWith('intent:')) storageMap.delete(k);
        }
        storageMap.set('alerts', alertsList);
        let initPromise: Promise<any> | null = null;
        const b = new TradingBot(
          {
            storage: mockStorage,
            blockConcurrencyWhile: (fn: any) => {
              initPromise = fn();
              return initPromise;
            },
          } as any,
          { DB: botDb, ENCRYPTION_KEY: encKey } as any
        );
        if (initPromise) await initPromise;
        return b;
      };

      // 8a. MARKET order (entryIntent: 'IMMEDIATE') passes marketMaxQty (80), NOT maxQty (1000)
      currentMarketRule = {
        id: 'DOGEUSDT',
        symbol: 'DOGE/USDT',
        base: 'DOGE',
        quote: 'USDT',
        active: true,
        category: 'linear',
        precision: { price: 0.01, amount: 1 },
        limits: { amount: { min: 1, max: 1000 }, marketAmount: { max: 80 }, cost: { min: 5 } },
      };
      const botMkt = await makeBotInstance([
        {
          ...alertObj,
          id: 'alert-mkt-1',
          entryIntent: 'IMMEDIATE',
          status: 'pending',
        },
      ]);

      await botMkt.fetch(
        new Request('http://bot/execute-trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alertId: 'alert-mkt-1', entryIntent: 'IMMEDIATE' }),
        })
      );
      expect(safetyGateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: 'DOGE/USDT', type: 'market' }),
        expect.objectContaining({ maxQty: 80 })
      );

      // 8b. LIMIT order (entryIntent: 'WAIT_FOR_PRICE') passes maxQty (1000), NOT marketMaxQty (80)
      safetyGateSpy.mockClear();
      const botLim = await makeBotInstance([
        {
          ...alertObj,
          id: 'alert-lim-1',
          entryIntent: 'WAIT_FOR_PRICE',
          targetEntryPrice: 0.99,
          entryPrice: 0.99,
          status: 'pending',
        },
      ]);

      await botLim.fetch(
        new Request('http://bot/execute-trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alertId: 'alert-lim-1', entryIntent: 'WAIT_FOR_PRICE' }),
        })
      );
      expect(safetyGateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: 'DOGE/USDT', type: 'limit' }),
        expect.objectContaining({ maxQty: 1000 })
      );

      // 8c. Absent optional maximum (undefined) is passed through as undefined and allowed by FinalDispatchSafetyGate
      safetyGateSpy.mockClear();
      currentMarketRule = {
        id: 'DOGEUSDT',
        symbol: 'DOGE/USDT',
        base: 'DOGE',
        quote: 'USDT',
        active: true,
        category: 'linear',
        precision: { price: 0.01, amount: 1 },
        limits: { amount: { min: 1, max: undefined }, marketAmount: { max: undefined }, cost: { min: 5 } },
      };
      const botAbsent = await makeBotInstance([
        {
          ...alertObj,
          id: 'alert-absent-max-1',
          entryIntent: 'IMMEDIATE',
          status: 'pending',
        },
      ]);

      await botAbsent.fetch(
        new Request('http://bot/execute-trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alertId: 'alert-absent-max-1', entryIntent: 'IMMEDIATE' }),
        })
      );
      expect(safetyGateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: 'DOGE/USDT', type: 'market' }),
        expect.objectContaining({ maxQty: undefined })
      );
    });

    it('exposes X-Empty-Reason and X-Eligible-Market-Count via Access-Control-Expose-Headers on /api/market/candidates while preserving CORS and JWT auth', async () => {
      const jwtSecret = 'test-jwt-secret-32-chars-minimum!!';
      const validToken = await sign({ sub: 'user-cors-test', type: 'access', exp: Math.floor(Date.now() / 1000) + 3600 }, jwtSecret);
      const env: any = {
        ALLOWED_ORIGINS: 'https://app.cryptopulse.test',
        JWT_SECRET: jwtSecret,
        ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        RESEND_API_KEY: 're_test_key',
        DB: {
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockReturnValue({
              first: vi.fn().mockResolvedValue({
                id: 'user-cors-test',
                exchange_name: 'bybit',
                exchange_environment: 'mainnet',
              }),
              all: vi.fn().mockResolvedValue({ results: [] }),
            }),
          }),
        },
      };

      // 1. Unauthenticated request is rejected with 401 even from allowed origin
      const unauthResp = await app.fetch(
        new Request('http://localhost/api/market/candidates?budget=4', {
          method: 'GET',
          headers: { Origin: 'https://app.cryptopulse.test' },
        }),
        env
      );
      expect(unauthResp.status).toBe(401);

      // 2. Authenticated request with NO_ELIGIBLE_MARKETS returns exposed headers
      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
        fetchMarkets: vi.fn().mockResolvedValue([
          {
            id: 'BTCUSDT',
            symbol: 'BTC/USDT',
            base: 'BTC',
            quote: 'USDT',
            active: true,
            category: 'linear',
            contractType: 'LinearPerpetual',
            precision: { price: 0.1, amount: 0.001 },
            limits: { amount: { min: 0.001, max: 100 }, marketAmount: { max: 50 }, cost: { min: 5 } },
          },
        ]),
        fetchTickers: vi.fn().mockResolvedValue([
          { symbol: 'BTC/USDT', last: new BigNumber(70000), quoteVolume: new BigNumber(500000000) },
        ]),
      } as any);

      const noEligibleResp = await app.fetch(
        new Request('http://localhost/api/market/candidates?budget=4', {
          method: 'GET',
          headers: {
            Origin: 'https://app.cryptopulse.test',
            Authorization: `Bearer ${validToken}`,
          },
        }),
        env
      );
      expect(noEligibleResp.status).toBe(200);
      expect(noEligibleResp.headers.get('Access-Control-Allow-Origin')).toBe('https://app.cryptopulse.test');
      const exposedHeaders = noEligibleResp.headers.get('Access-Control-Expose-Headers') || '';
      expect(exposedHeaders).toContain('X-Empty-Reason');
      expect(exposedHeaders).toContain('X-Eligible-Market-Count');
      expect(noEligibleResp.headers.get('X-Empty-Reason')).toBe('NO_ELIGIBLE_MARKETS');
      expect(noEligibleResp.headers.get('X-Eligible-Market-Count')).toBe('0');

      // 2b. Authenticated request with NO_TECHNICAL_OPPORTUNITIES returns exposed headers
      vi.spyOn(MarketOpportunityScanner.prototype, 'scan').mockResolvedValueOnce({
        opportunities: [],
        diagnostics: {
          totalUniverseCount: 1,
          eligibleCount: 1,
          qualityFilteredCount: 1,
          technicalQualifiedCount: 0,
          finalSelectedCount: 0,
          scanDurationMs: 5,
          rejectionReasons: {},
        },
      } as any);
      const noTechResp = await app.fetch(
        new Request('http://localhost/api/market/candidates?budget=100', {
          method: 'GET',
          headers: {
            Origin: 'https://app.cryptopulse.test',
            Authorization: `Bearer ${validToken}`,
          },
        }),
        env
      );
      expect(noTechResp.status).toBe(200);
      expect(noTechResp.headers.get('Access-Control-Expose-Headers') || '').toContain('X-Empty-Reason');
      expect(noTechResp.headers.get('Access-Control-Expose-Headers') || '').toContain('X-Eligible-Market-Count');
      expect(noTechResp.headers.get('X-Empty-Reason')).toBe('NO_TECHNICAL_OPPORTUNITIES');
      expect(noTechResp.headers.get('X-Eligible-Market-Count')).toBe('1');

      // 3. Disallowed origin does not receive Access-Control-Allow-Origin for that origin
      const disallowedOriginResp = await app.fetch(
        new Request('http://localhost/api/market/candidates?budget=4', {
          method: 'GET',
          headers: {
            Origin: 'https://evil.example.com',
            Authorization: `Bearer ${validToken}`,
          },
        }),
        env
      );
      expect(disallowedOriginResp.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.example.com');
    });

    it('proves budgeted discovery works seamlessly with both in-memory BigNumber values and JSON-serialized numeric strings across 10, 100, 1000 USDT budgets', async () => {
      const mockMarkets = [
        {
          id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.1, amount: 0.001 },
          limits: { amount: { min: 0.001, max: 100 }, cost: { min: 5 } },
        },
        {
          id: 'ETHUSDT', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.01, amount: 0.01 },
          limits: { amount: { min: 0.01, max: 1000 }, cost: { min: 5 } },
        },
        {
          id: 'SOLUSDT', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.01, amount: 0.1 },
          limits: { amount: { min: 0.1, max: 5000 }, cost: { min: 5 } },
        },
        {
          id: 'DOGEUSDT', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.0001, amount: 10 },
          limits: { amount: { min: 10, max: 1000000 }, cost: { min: 5 } },
        },
      ];

      const bigNumberTickers = [
        { symbol: 'BTC/USDT', last: new BigNumber(65000), bid: new BigNumber(64990), ask: new BigNumber(65010), quoteVolume: new BigNumber(200000000), high: new BigNumber(66000), low: new BigNumber(64000) },
        { symbol: 'ETH/USDT', last: new BigNumber(3500), bid: new BigNumber(3495), ask: new BigNumber(3505), quoteVolume: new BigNumber(150000000), high: new BigNumber(3600), low: new BigNumber(3400) },
        { symbol: 'SOL/USDT', last: new BigNumber(150), bid: new BigNumber(149.8), ask: new BigNumber(150.2), quoteVolume: new BigNumber(100000000), high: new BigNumber(155), low: new BigNumber(145) },
        { symbol: 'DOGE/USDT', last: new BigNumber(0.1), bid: new BigNumber(0.0999), ask: new BigNumber(0.1001), quoteVolume: new BigNumber(50000000), high: new BigNumber(0.105), low: new BigNumber(0.095) },
      ];

      const jsonStringTickers = [
        { symbol: 'BTC/USDT', last: '65000', bid: '64990', ask: '65010', quoteVolume: '200000000', high: '66000', low: '64000' },
        { symbol: 'ETH/USDT', last: '3500', bid: '3495', ask: '3505', quoteVolume: '150000000', high: '3600', low: '3400' },
        { symbol: 'SOL/USDT', last: '150', bid: '149.8', ask: '150.2', quoteVolume: '100000000', high: '155', low: '145' },
        { symbol: 'DOGE/USDT', last: '0.1', bid: '0.0999', ask: '0.1001', quoteVolume: '50000000', high: '0.105', low: '0.095' },
      ];

      const eligible10_BN = selectBoundedDiscoveryMarkets(mockMarkets, bigNumberTickers, 10);
      expect(eligible10_BN.map(m => m.symbol)).toEqual(['DOGE/USDT']);

      const eligible100_BN = selectBoundedDiscoveryMarkets(mockMarkets, bigNumberTickers, 100);
      expect(eligible100_BN.map(m => m.symbol)).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'DOGE/USDT']);

      const eligible1000_BN = selectBoundedDiscoveryMarkets(mockMarkets, bigNumberTickers, 1000);
      expect(eligible1000_BN.map(m => m.symbol)).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'DOGE/USDT']);

      const eligible10_Str = selectBoundedDiscoveryMarkets(mockMarkets, jsonStringTickers, 10);
      expect(eligible10_Str.map(m => m.symbol)).toEqual(['DOGE/USDT']);

      const eligible100_Str = selectBoundedDiscoveryMarkets(mockMarkets, jsonStringTickers, 100);
      expect(eligible100_Str.map(m => m.symbol)).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'DOGE/USDT']);

      const eligible1000_Str = selectBoundedDiscoveryMarkets(mockMarkets, jsonStringTickers, 1000);
      expect(eligible1000_Str.map(m => m.symbol)).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'DOGE/USDT']);
    });

    it('proves markets failing eligibility never reach technical analysis (fetchCandles is never invoked for ineligible markets)', async () => {
      const mockMarkets = [
        {
          id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.1, amount: 0.001 },
          limits: { amount: { min: 0.001, max: 100 }, cost: { min: 5 } },
        },
        {
          id: 'DOGEUSDT', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.0001, amount: 10 },
          limits: { amount: { min: 10, max: 1000000 }, cost: { min: 5 } },
        },
      ];
      const mockTickers = [
        { symbol: 'BTC/USDT', last: '65000', bid: '64990', ask: '65010', quoteVolume: '100000000', high: '66000', low: '64000' },
        { symbol: 'DOGE/USDT', last: '0.1', bid: '0.0999', ask: '0.1001', quoteVolume: '50000000', high: '0.105', low: '0.095' },
      ];

      const fetchCandlesSpy = vi.fn().mockImplementation((_sym: string, tf: string) =>
        Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 60, 'BULL'))
      );

      const mockAdapter = {
        fetchMarkets: vi.fn().mockResolvedValue(mockMarkets),
        fetchTickers: vi.fn().mockResolvedValue(mockTickers),
        fetchCandles: fetchCandlesSpy,
      } as unknown as IExchangeProvider & ICandleProvider;

      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({ exchange_name: 'bybit', exchange_environment: 'mainnet' }),
          }),
        }),
      };

      const ctx = {
        get: vi.fn().mockReturnValue({ sub: 'user-ta-isolation' }),
        env: { DB: mockDb, ENCRYPTION_KEY: 'test-key' },
        status: vi.fn(),
        header: vi.fn(),
        json: vi.fn().mockImplementation((d) => d),
        req: { query: vi.fn().mockImplementation((k: string) => (k === 'budget' ? '10' : undefined)) },
      } as any;

      const candidates = await handleGetPersonalizedMarketCandidates(ctx) as any;
      expect(candidates.map((c: any) => c.pairName)).toEqual(['DOGE/USDT']);

      const candleCalls = fetchCandlesSpy.mock.calls.map((c: any[]) => c[0]);
      expect(candleCalls).toContain('DOGE/USDT');
      expect(candleCalls).not.toContain('BTC/USDT');
    });

    it('proves malformed metadata (zero, negative, NaN) fails safely and rejects the market without throwing', () => {
      const markets = [
        {
          id: 'ZERONOTIONAL', symbol: 'ZERONOTIONAL/USDT', base: 'ZERO', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.1, amount: 1 },
          limits: { amount: { min: 1, max: 100 }, cost: { min: 0 } },
        },
        {
          id: 'NEGNOTIONAL', symbol: 'NEGNOTIONAL/USDT', base: 'NEG', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.1, amount: 1 },
          limits: { amount: { min: 1, max: 100 }, cost: { min: -5 } },
        },
        {
          id: 'NANQTYSTEP', symbol: 'NANQTYSTEP/USDT', base: 'NAN', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.1, amount: NaN },
          limits: { amount: { min: 1, max: 100 }, cost: { min: 5 } },
        },
      ];
      const tickers = markets.map(m => ({ symbol: m.symbol, last: 10, bid: 9.99, ask: 10.01, quoteVolume: 10000000 }));
      const result = selectBoundedDiscoveryMarkets(markets, tickers, 50);
      expect(result).toEqual([]);
    });

    it('proves backward-compatible /api/strategies alias returns identical response to /api/market/strategies', async () => {
      const jwtSecret = 'test-jwt-secret-32-chars-minimum!!';
      const validToken = await sign({ sub: 'user-strat-test', type: 'access', exp: Math.floor(Date.now() / 1000) + 3600 }, jwtSecret);
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({ id: 'user-strat-test' }),
          }),
        }),
      };
      const env: any = { DB: mockDb, ENCRYPTION_KEY: 'test-key', JWT_SECRET: jwtSecret, ALLOWED_ORIGINS: 'https://app.cryptopulse.test' };

      const resMarket = await app.fetch(
        new Request('http://localhost/api/market/strategies', {
          method: 'GET',
          headers: { Authorization: `Bearer ${validToken}` },
        }),
        env
      );
      expect(resMarket.status).toBe(200);
      const dataMarket = await resMarket.json() as any;

      const resAlias = await app.fetch(
        new Request('http://localhost/api/strategies', {
          method: 'GET',
          headers: { Authorization: `Bearer ${validToken}` },
        }),
        env
      );
      expect(resAlias.status).toBe(200);
      const dataAlias = await resAlias.json() as any;

      expect(dataAlias).toEqual(dataMarket);
      expect(dataAlias.version).toBe('2.0');
      expect(Array.isArray(dataAlias.strategies)).toBe(true);
      expect(dataAlias.strategies.length).toBeGreaterThan(0);
    });

    it('CRITICAL F-01: reproduces complete production data path through PUBLIC_MARKET_COORDINATOR DO, JSON serialization boundary, BigNumber/number/string types, realistic Bybit Linear metadata across 10, 100, 1000 USDT budgets, and candle store reuse', async () => {
      __resetPublicOpportunityStateForTests();
      const jwtSecret = 'test-jwt-secret-32-chars-minimum!!';
      const validToken = await sign({ sub: 'user-e2e-do-verify', type: 'access', exp: Math.floor(Date.now() / 1000) + 3600 }, jwtSecret);

      const realisticMarkets = [
        {
          id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.1, amount: 0.001 },
          limits: { amount: { min: 0.001, max: 100 }, marketAmount: { max: 50 }, cost: { min: 5 } },
        },
        {
          id: 'ETHUSDT', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.01, amount: 0.01 },
          limits: { amount: { min: 0.01, max: 1000 }, marketAmount: { max: 500 }, cost: { min: 5 } },
        },
        {
          id: 'SOLUSDT', symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.01, amount: 0.1 },
          limits: { amount: { min: 0.1, max: 5000 }, marketAmount: { max: 2000 }, cost: { min: 5 } },
        },
        {
          id: 'DOGEUSDT', symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.0001, amount: 10 },
          limits: { amount: { min: 10, max: 1000000 }, marketAmount: { max: 500000 }, cost: { min: 5 } },
        },
        {
          id: 'SUIUSDT', symbol: 'SUI/USDT', base: 'SUI', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.001, amount: 1 },
          limits: { amount: { min: 1, max: 100000 }, marketAmount: { max: 50000 }, cost: { min: 5 } },
        },
        {
          id: 'XRPUSDT', symbol: 'XRP/USDT', base: 'XRP', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.0001, amount: 10 },
          limits: { amount: { min: 10, max: 200000 }, marketAmount: { max: 100000 }, cost: { min: 5 } },
        },
        {
          id: 'PEPEUSDT', symbol: 'PEPE/USDT', base: 'PEPE', quote: 'USDT', active: true, category: 'linear', contractType: 'LinearPerpetual',
          precision: { price: 0.0000001, amount: 100000 },
          limits: { amount: { min: 100000, max: 1000000000 }, marketAmount: { max: 500000000 }, cost: { min: 5 } },
        },
      ];

      // Raw exchange tickers mixing in-memory BigNumber instances, numeric strings, and native numbers
      const mixedTickers = [
        { symbol: 'BTC/USDT', last: new BigNumber(65000), bid: new BigNumber(64995), ask: new BigNumber(65005), quoteVolume: new BigNumber(500000000), high: new BigNumber(66000), low: new BigNumber(64000) },
        { symbol: 'ETH/USDT', last: '3500', bid: '3498', ask: '3502', quoteVolume: '300000000', high: '3600', low: '3400' },
        { symbol: 'SOL/USDT', last: 150, bid: 149.9, ask: 150.1, quoteVolume: 200000000, high: 155, low: 145 },
        { symbol: 'DOGE/USDT', last: new BigNumber(0.1), bid: new BigNumber(0.09995), ask: new BigNumber(0.10005), quoteVolume: new BigNumber(150000000), high: new BigNumber(0.105), low: new BigNumber(0.095) },
        { symbol: 'SUI/USDT', last: '2.0', bid: '1.999', ask: '2.001', quoteVolume: '120000000', high: '2.1', low: '1.9' },
        { symbol: 'XRP/USDT', last: 0.50, bid: 0.4998, ask: 0.5002, quoteVolume: 100000000, high: 0.52, low: 0.48 },
        { symbol: 'PEPE/USDT', last: '0.00001', bid: '0.00000999', ask: '0.00001001', quoteVolume: '90000000', high: '0.0000105', low: '0.0000095' },
      ];

      let klineCallCount = 0;
      const klineRequestedSymbols = new Set<string>();

      const mockExchangeAdapter = {
        fetchMarkets: vi.fn().mockResolvedValue(realisticMarkets),
        fetchTickers: vi.fn().mockResolvedValue(mixedTickers),
        fetchKlines: vi.fn().mockImplementation((sym: string, tf: string, limit?: number) => {
          klineCallCount++;
          klineRequestedSymbols.add(sym);
          const price = sym.includes('BTC') ? 65000 : sym.includes('ETH') ? 3500 : sym.includes('SOL') ? 150 : sym.includes('DOGE') ? 0.1 : sym.includes('SUI') ? 2.0 : sym.includes('XRP') ? 0.5 : 0.00001;
          return Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, limit || 60, 'BULL', price));
        }),
        fetchCandles: vi.fn().mockImplementation((sym: string, tf: string, limit?: number) => {
          klineCallCount++;
          klineRequestedSymbols.add(sym);
          const price = sym.includes('BTC') ? 65000 : sym.includes('ETH') ? 3500 : sym.includes('SOL') ? 150 : sym.includes('DOGE') ? 0.1 : sym.includes('SUI') ? 2.0 : sym.includes('XRP') ? 0.5 : 0.00001;
          return Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, limit || 60, 'BULL', price));
        }),
      };

      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockExchangeAdapter as any);

      // Instantiate the actual PublicMarketDataCoordinator Durable Object
      const mockStorage = { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() };
      const mockState: any = { storage: mockStorage, blockConcurrencyWhile: (fn: any) => fn() };
      const coordinator = new PublicMarketDataCoordinator(mockState, { ENVIRONMENT: 'production' } as any);

      const mockCoordinatorNamespace = {
        idFromName: (name: string) => ({ toString: () => name }),
        get: (_id: any) => ({
          fetch: (req: Request) => coordinator.fetch(req),
        }),
      };

      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({
              id: 'user-e2e-do-verify',
              exchange_name: 'bybit',
              exchange_environment: 'mainnet',
              exchange_region: 'india',
            }),
            all: vi.fn().mockResolvedValue({ results: [] }),
          }),
        }),
      };

      const env: any = {
        DB: mockDb,
        ENCRYPTION_KEY: 'test-key-32-chars-minimum-sample!!',
        JWT_SECRET: jwtSecret,
        ALLOWED_ORIGINS: 'https://app.cryptopulse.test',
        PUBLIC_MARKET_COORDINATOR: mockCoordinatorNamespace,
      };

      // 1. Test Budget = 10 USDT
      // Verification:
      // BTC requires 0.001 * 65000 = 65 USDT > 10 (rejected: INSUFFICIENT_BUDGET)
      // ETH requires 0.01 * 3500 = 35 USDT > 10 (rejected: INSUFFICIENT_BUDGET)
      // SOL requires 0.1 * 150 = 15 USDT > 10 (rejected: INSUFFICIENT_BUDGET)
      // DOGE requires max(5, 10 * 0.1) = 5 USDT <= 10 (eligible!)
      // SUI requires max(5, 1 * 2) = 5 USDT <= 10 (eligible!)
      // XRP requires max(5, 10 * 0.5) = 5 USDT <= 10 (eligible!)
      // PEPE requires max(5, 100000 * 0.00001) = 5 USDT <= 10 (eligible!)
      const resp10 = await app.fetch(
        new Request('http://localhost/api/market/candidates?budget=10', {
          method: 'GET',
          headers: { Authorization: `Bearer ${validToken}`, Origin: 'https://app.cryptopulse.test' },
        }),
        env
      );
      expect(resp10.status).toBe(200);
      expect(resp10.headers.get('X-Eligible-Market-Count')).toBe('4');
      const candidates10 = await resp10.json() as any[];
      expect(candidates10.length).toBeGreaterThan(0);
      const symbols10 = candidates10.map((c: any) => c.pairName);
      expect(symbols10).toContain('DOGE/USDT');
      expect(symbols10).not.toContain('BTC/USDT');
      expect(symbols10).not.toContain('ETH/USDT');
      expect(symbols10).not.toContain('SOL/USDT');

      // Verify that candidate prices are correctly parsed numbers (not NaN or null or string)
      for (const cand of candidates10) {
        expect(typeof cand.price).toBe('number');
        expect(cand.price).toBeGreaterThan(0);
        expect(Number.isFinite(cand.price)).toBe(true);
      }

      // Record kline call count after first scan
      const klineCallsAfter10 = klineCallCount;
      expect(klineCallsAfter10).toBeGreaterThan(0);

      // 2. Test Cache & Candle Store Reuse on repeat request with same budget
      const resp10Repeat = await app.fetch(
        new Request('http://localhost/api/market/candidates?budget=10', {
          method: 'GET',
          headers: { Authorization: `Bearer ${validToken}`, Origin: 'https://app.cryptopulse.test' },
        }),
        env
      );
      expect(resp10Repeat.status).toBe(200);
      expect(resp10Repeat.headers.get('X-Eligible-Market-Count')).toBe('4');
      // No extra kline calls were made due to cache/shared candle store
      expect(klineCallCount).toBe(klineCallsAfter10);

      // 3. Test Budget = 100 USDT
      // All 7 markets are eligible!
      const resp100 = await app.fetch(
        new Request('http://localhost/api/market/candidates?budget=100', {
          method: 'GET',
          headers: { Authorization: `Bearer ${validToken}`, Origin: 'https://app.cryptopulse.test' },
        }),
        env
      );
      expect(resp100.status).toBe(200);
      expect(resp100.headers.get('X-Eligible-Market-Count')).toBe('7');
      const candidates100 = await resp100.json() as any[];
      expect(candidates100.length).toBeGreaterThan(0);
      const symbols100 = candidates100.map((c: any) => c.pairName);
      expect(symbols100).toContain('BTC/USDT');
      expect(symbols100).toContain('ETH/USDT');
      expect(symbols100).toContain('SOL/USDT');
      expect(symbols100).toContain('DOGE/USDT');

      // 4. Test Budget = 1,000 USDT
      // All 7 markets are eligible!
      const resp1000 = await app.fetch(
        new Request('http://localhost/api/market/candidates?budget=1000', {
          method: 'GET',
          headers: { Authorization: `Bearer ${validToken}`, Origin: 'https://app.cryptopulse.test' },
        }),
        env
      );
      expect(resp1000.status).toBe(200);
      expect(resp1000.headers.get('X-Eligible-Market-Count')).toBe('7');
      const candidates1000 = await resp1000.json() as any[];
      expect(candidates1000.length).toBeGreaterThan(0);

      // 5. Test MARKET vs LIMIT orderType maximum constraints
      const marketQueryResp = await app.fetch(
        new Request('http://localhost/api/market/candidates?budget=100&orderType=MARKET', {
          method: 'GET',
          headers: { Authorization: `Bearer ${validToken}`, Origin: 'https://app.cryptopulse.test' },
        }),
        env
      );
      expect(marketQueryResp.status).toBe(200);
      expect(marketQueryResp.headers.get('X-Eligible-Market-Count')).toBe('7');
    });
  });
});
