import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketOpportunityScanner, ScannerScanResult } from './MarketOpportunityScanner';
import { MultiTimeframeCandleStore, ScannerTimeframe } from './MultiTimeframeCandleStore';
import { TradingCostEngine } from './TradingCostEngine';
import { StrategyCompatibilityEvaluator } from './StrategyCompatibilityEvaluator';
import { OpportunityRanker } from './OpportunityRanker';
import { DEFAULT_SCANNER_CONFIG } from './ScannerTypes';
import { IExchangeProvider } from '../../exchanges/IExchangeProvider';
import { ICandleProvider } from '../../infrastructure/exchange/types';
import { CandleValidator } from '../../infrastructure/exchange/CandleValidator';

function generateCandles(timeframe: ScannerTimeframe, count: number = 60, trend: 'BULL' | 'BEAR' | 'FLAT' = 'BULL') {
  const tfMs = CandleValidator.timeframeToMs(timeframe);
  const now = Date.now();
  const startTime = now - count * tfMs;

  return Array.from({ length: count }, (_, i) => {
    let base = 100;
    let step = 0;
    if (trend === 'BULL') {
      base = 100;
      step = i * 1.5;
    } else if (trend === 'BEAR') {
      base = 300;
      step = -i * 1.5;
    }

    const close = base + step;
    return {
      timestamp: startTime + i * tfMs,
      openTime: startTime + i * tfMs,
      open: close - 0.5,
      high: close + 2.0,
      low: close - 2.0,
      close: close,
      volume: 5000 + i * 50,
    };
  });
}

describe('MarketOpportunityScanner (Phase 2 Full-Universe Live Scanning)', () => {
  let mockProvider: IExchangeProvider & ICandleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ingests 500+ symbol universe and strictly filters out stablecoins, leveraged tokens, non-linear, and inactive markets', async () => {
    // Generate 520 markets
    const markets: any[] = [];
    
    // 480 valid linear perpetuals
    for (let i = 1; i <= 480; i++) {
      markets.push({
        id: `COIN${i}USDT`,
        symbol: `COIN${i}/USDT`,
        base: `COIN${i}`,
        quote: 'USDT',
        active: true,
        category: 'linear',
        limits: { cost: { min: 5 }, amount: { min: 0.01 } },
        precision: { price: 0.01, amount: 0.01 },
      });
    }

    // 10 stablecoins
    const stables = ['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'BUSD', 'USDE', 'PYUSD', 'FRAX', 'LUSD'];
    stables.forEach((s) => {
      markets.push({
        id: `${s}USDT`,
        symbol: `${s}/USDT`,
        base: s,
        quote: 'USDT',
        active: true,
        category: 'linear',
      });
    });

    // 10 leveraged tokens
    const leveraged = ['BTC3L', 'ETH3S', 'SOL10L', 'BTCUP', 'BTCDOWN', 'ETHBULL', 'ETHBEAR', 'AVAX2L', 'DOGE3S', 'LINK4L'];
    leveraged.forEach((lt) => {
      markets.push({
        id: `${lt}USDT`,
        symbol: `${lt}/USDT`,
        base: lt,
        quote: 'USDT',
        active: true,
        category: 'linear',
      });
    });

    // 10 spot/non-linear contracts
    for (let i = 1; i <= 10; i++) {
      markets.push({
        id: `SPOT${i}USDT`,
        symbol: `SPOT${i}/USDT`,
        base: `SPOT${i}`,
        quote: 'USDT',
        active: true,
        category: 'spot',
      });
    }

    // 10 inactive markets
    for (let i = 1; i <= 10; i++) {
      markets.push({
        id: `DELISTED${i}USDT`,
        symbol: `DELISTED${i}/USDT`,
        base: `DELISTED${i}`,
        quote: 'USDT',
        active: false,
        category: 'linear',
      });
    }

    expect(markets.length).toBe(520);

    // Mock tickers for all markets
    mockProvider = {
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockImplementation((symbols: string[]) => {
        return Promise.resolve(
          symbols.map((sym) => ({
            symbol: sym,
            last: 50.0,
            bid: 49.99,
            ask: 50.01,
            quoteVolume: 500_000, // below min turnover
            high: 51.0,
            low: 49.0,
            timestamp: Date.now(),
          }))
        );
      }),
      fetchCandles: vi.fn().mockResolvedValue([]),
    } as unknown as IExchangeProvider & ICandleProvider;

    const scanner = new MarketOpportunityScanner(mockProvider);
    const result = await scanner.scan();

    expect(result.universeSize).toBe(520);
    // 520 - 10 stablecoins - 10 leveraged - 10 spot - 10 inactive = 480 eligible
    expect(result.eligibleCount).toBe(480);
    // All tickers had $500k turnover (< $1,000,000 threshold), so 0 quality candidates
    expect(result.qualityCount).toBe(0);
    expect(result.allQualifiedOpportunities.length).toBe(0);
  });

  it('discovers both LONG and SHORT opportunities across multi-timeframe analysis', async () => {
    const markets = [
      {
        id: 'BULLCOINUSDT',
        symbol: 'BULLCOIN/USDT',
        base: 'BULLCOIN',
        quote: 'USDT',
        active: true,
        category: 'linear',
        limits: { cost: { min: 5 }, amount: { min: 0.01 } },
        precision: { price: 0.01, amount: 0.01 },
      },
      {
        id: 'BEARCOINUSDT',
        symbol: 'BEARCOIN/USDT',
        base: 'BEARCOIN',
        quote: 'USDT',
        active: true,
        category: 'linear',
        limits: { cost: { min: 5 }, amount: { min: 0.01 } },
        precision: { price: 0.01, amount: 0.01 },
      },
    ];

    const tickers = [
      {
        symbol: 'BULLCOIN/USDT',
        last: 100.0,
        bid: 99.98,
        ask: 100.02,
        quoteVolume: 15_000_000,
        high: 105.0,
        low: 95.0,
        timestamp: Date.now(),
      },
      {
        symbol: 'BEARCOIN/USDT',
        last: 200.0,
        bid: 199.96,
        ask: 200.04,
        quoteVolume: 20_000_000,
        high: 210.0,
        low: 190.0,
        timestamp: Date.now(),
      },
    ];

    mockProvider = {
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockResolvedValue(tickers),
      fetchCandles: vi.fn().mockImplementation((sym: string, tf: string) => {
        const trend = sym.includes('BULL') ? 'BULL' : 'BEAR';
        return Promise.resolve(generateCandles(tf as ScannerTimeframe, 60, trend));
      }),
    } as unknown as IExchangeProvider & ICandleProvider;

    const scanner = new MarketOpportunityScanner(mockProvider);
    const result = await scanner.scan();

    expect(result.universeSize).toBe(2);
    expect(result.eligibleCount).toBe(2);
    expect(result.qualityCount).toBe(2);
    expect(result.allQualifiedOpportunities.length).toBe(2);

    const bullOpp = result.allQualifiedOpportunities.find((o) => o.symbol === 'BULLCOIN/USDT');
    const bearOpp = result.allQualifiedOpportunities.find((o) => o.symbol === 'BEARCOIN/USDT');

    expect(bullOpp).toBeDefined();
    expect(bullOpp?.dominantDirection).toBe('LONG');
    expect(bullOpp?.longEvaluation.mtfAlignmentScore).toBeGreaterThan(50);
    // Preserves shortEvaluation without bias
    expect(bullOpp?.shortEvaluation).toBeDefined();

    expect(bearOpp).toBeDefined();
    expect(bearOpp?.dominantDirection).toBe('SHORT');
    expect(bearOpp?.shortEvaluation.mtfAlignmentScore).toBeGreaterThan(50);
    // Preserves longEvaluation without bias
    expect(bearOpp?.longEvaluation).toBeDefined();

    // Verify strategy directional compatibility
    // Bull coin matches LONG-capable strategies (ScalperV2, Momentum, Breakout, etc.)
    const bullStrategies = bullOpp!.strategyCompatibility.filter(s => s.isAllowedInRegime).map(s => s.strategyId);
    expect(bullStrategies.length).toBeGreaterThan(0);

    // Bear coin allows strategies supporting SHORT in trending regime
    const bearAllowed = bearOpp!.strategyCompatibility.filter(s => s.isAllowedInRegime).map(s => s.strategyId);
    expect(bearAllowed).toContain('VWAP');
    expect(bearAllowed).toContain('ScalperV2');
    expect(bearAllowed).toContain('Momentum');
    expect(bearAllowed).toContain('Breakout');
    const bearDisqualified = bearOpp!.strategyCompatibility.filter(s => !s.isAllowedInRegime).map(s => s.strategyId);
    // MeanReversion is not allowed in TRENDING regime
    expect(bearDisqualified).toContain('MeanReversion');
  });

  it('isolates single-pair failures so broken symbols do not abort the scan cycle', async () => {
    const markets = [
      {
        id: 'OKCOIN1USDT',
        symbol: 'OKCOIN1/USDT',
        quote: 'USDT',
        active: true,
        category: 'linear',
      },
      {
        id: 'FAILCOINUSDT',
        symbol: 'FAILCOIN/USDT',
        quote: 'USDT',
        active: true,
        category: 'linear',
      },
      {
        id: 'OKCOIN2USDT',
        symbol: 'OKCOIN2/USDT',
        quote: 'USDT',
        active: true,
        category: 'linear',
      },
    ];

    const tickers = [
      { symbol: 'OKCOIN1/USDT', last: 10.0, bid: 9.99, ask: 10.01, quoteVolume: 10_000_000, high: 10.5, low: 9.5 },
      { symbol: 'FAILCOIN/USDT', last: 50.0, bid: 49.95, ask: 50.05, quoteVolume: 10_000_000, high: 52.0, low: 48.0 },
      { symbol: 'OKCOIN2/USDT', last: 20.0, bid: 19.98, ask: 20.02, quoteVolume: 10_000_000, high: 21.0, low: 19.0 },
    ];

    mockProvider = {
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockResolvedValue(tickers),
      fetchCandles: vi.fn().mockImplementation((sym: string, tf: string) => {
        if (sym.includes('FAILCOIN')) {
          return Promise.reject(new Error('Bybit network 502 Bad Gateway'));
        }
        return Promise.resolve(generateCandles(tf as ScannerTimeframe, 60, 'BULL'));
      }),
    } as unknown as IExchangeProvider & ICandleProvider;

    const scanner = new MarketOpportunityScanner(mockProvider);
    const result = await scanner.scan();

    expect(result.eligibleCount).toBe(3);
    // The failing coin did not crash the pipeline
    expect(result.allQualifiedOpportunities.length).toBe(2);
    const symbols = result.allQualifiedOpportunities.map((o) => o.symbol);
    expect(symbols).toContain('OKCOIN1/USDT');
    expect(symbols).toContain('OKCOIN2/USDT');
    expect(symbols).not.toContain('FAILCOIN/USDT');
  });

  it('detects candle data degradation and filters out symbols with stale or missing data', async () => {
    const markets = [
      { id: 'STALECOINUSDT', symbol: 'STALECOIN/USDT', quote: 'USDT', active: true, category: 'linear' },
    ];
    const tickers = [
      { symbol: 'STALECOIN/USDT', last: 50.0, bid: 49.95, ask: 50.05, quoteVolume: 10_000_000, high: 52.0, low: 48.0 },
    ];

    // Generate stale candles (timestamps from 7 days ago)
    const oldTimestamp = Date.now() - 7 * 24 * 3600 * 1000;
    const staleCandles = Array.from({ length: 60 }, (_, i) => ({
      timestamp: oldTimestamp + i * 3600000,
      openTime: oldTimestamp + i * 3600000,
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 1000,
    }));

    mockProvider = {
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockResolvedValue(tickers),
      fetchCandles: vi.fn().mockResolvedValue(staleCandles),
    } as unknown as IExchangeProvider & ICandleProvider;

    const scanner = new MarketOpportunityScanner(mockProvider);
    const result = await scanner.scan();

    // Data degradation detection should reject the candidate
    expect(result.allQualifiedOpportunities.length).toBe(0);
  });

  it('enforces quality over quota: unconstrained discovery set decoupled from display limit', async () => {
    // Generate 15 qualified symbols
    const markets = Array.from({ length: 15 }, (_, i) => ({
      id: `COIN${i}USDT`,
      symbol: `COIN${i}/USDT`,
      quote: 'USDT',
      active: true,
      category: 'linear',
    }));

    const tickers = markets.map((m, i) => ({
      symbol: m.symbol,
      last: 100.0 + i,
      bid: 99.98 + i,
      ask: 100.02 + i,
      quoteVolume: 15_000_000,
      high: 105.0 + i,
      low: 95.0 + i,
      timestamp: Date.now(),
    }));

    mockProvider = {
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockResolvedValue(tickers),
      fetchCandles: vi.fn().mockImplementation((_sym: string, tf: string) => {
        return Promise.resolve(generateCandles(tf as ScannerTimeframe, 60, 'BULL'));
      }),
    } as unknown as IExchangeProvider & ICandleProvider;

    const customConfig = {
      ...DEFAULT_SCANNER_CONFIG,
      displayLimit: 5, // Display limit is 5
    };

    const scanner = new MarketOpportunityScanner(mockProvider, customConfig);
    const result = await scanner.scan();

    // Unconstrained discovery set contains ALL 15 qualified candidates
    expect(result.allQualifiedOpportunities.length).toBe(15);
    // Displayed set is bounded by display limit (5)
    expect(result.topOpportunities.length).toBe(5);

    // Verify telemetry
    expect(result.telemetry.universeSize).toBe(15);
    expect(result.telemetry.eligibleCount).toBe(15);
    expect(result.telemetry.qualifiedOpportunityCount).toBe(15);
    expect(result.telemetry.executionDurationMs).toBeGreaterThan(0);
  });

  it('reuses multi-timeframe candle cache on successive scans within TTL', async () => {
    const markets = [
      { id: 'CACHECOINUSDT', symbol: 'CACHECOIN/USDT', quote: 'USDT', active: true, category: 'linear' },
    ];
    const tickers = [
      { symbol: 'CACHECOIN/USDT', last: 100.0, bid: 99.98, ask: 100.02, quoteVolume: 15_000_000, high: 105.0, low: 95.0 },
    ];

    const fetchCandlesSpy = vi.fn().mockImplementation((_sym: string, tf: string) => {
      return Promise.resolve(generateCandles(tf as ScannerTimeframe, 60, 'BULL'));
    });

    mockProvider = {
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockResolvedValue(tickers),
      fetchCandles: fetchCandlesSpy,
    } as unknown as IExchangeProvider & ICandleProvider;

    const scanner = new MarketOpportunityScanner(mockProvider);

    // Cycle 1: Fetches 4 timeframes (4h, 1h, 15m, 5m)
    await scanner.scan();
    const firstCallCount = fetchCandlesSpy.mock.calls.length;
    expect(firstCallCount).toBe(4);
    // Cycle 2 immediately after: Candle store cache hits
    await scanner.scan();
    const secondCallCount = fetchCandlesSpy.mock.calls.length;
    // No new candle network calls within TTL!
    expect(secondCallCount).toBe(firstCallCount);
  });

  it('deduplicates duplicate instrument inputs and filters dated linear futures from deep analysis', async () => {
    const markets = [
      {
        id: 'ETHUSDT',
        symbol: 'ETH/USDT',
        base: 'ETH',
        quote: 'USDT',
        active: true,
        category: 'linear',
        contractType: 'LinearPerpetual',
        limits: { cost: { min: 5 }, amount: { min: 0.01 } },
      },
      // Duplicate ETH perpetual record (should be deduplicated at Stage 1)
      {
        id: 'ETHUSDT_DUP',
        symbol: 'ETH/USDT',
        base: 'ETH',
        quote: 'USDT',
        active: true,
        category: 'linear',
        contractType: 'LinearPerpetual',
        limits: { cost: { min: 5 }, amount: { min: 0.01 } },
      },
      // Dated linear delivery futures (should be filtered out of perpetual scanner universe)
      {
        id: 'ETH-26SEP25',
        symbol: 'ETH-26SEP25/USDT',
        base: 'ETH',
        quote: 'USDT',
        active: true,
        category: 'linear',
        contractType: 'LinearFutures',
        limits: { cost: { min: 5 }, amount: { min: 0.01 } },
      },
      // Distinct coin SOL
      {
        id: 'SOLUSDT',
        symbol: 'SOL/USDT',
        base: 'SOL',
        quote: 'USDT',
        active: true,
        category: 'linear',
        contractType: 'LinearPerpetual',
        limits: { cost: { min: 5 }, amount: { min: 0.01 } },
      },
    ];

    const tickers = [
      { symbol: 'ETH/USDT', last: 3500.0, bid: 3499.5, ask: 3500.5, quoteVolume: 50_000_000, high: 3600.0, low: 3400.0 },
      { symbol: 'SOL/USDT', last: 150.0, bid: 149.95, ask: 150.05, quoteVolume: 25_000_000, high: 155.0, low: 145.0 },
    ];

    const fetchCandlesSpy = vi.fn().mockImplementation((_sym: string, tf: string) => {
      return Promise.resolve(generateCandles(tf as ScannerTimeframe, 60, 'BULL'));
    });

    mockProvider = {
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockResolvedValue(tickers),
      fetchCandles: fetchCandlesSpy,
    } as unknown as IExchangeProvider & ICandleProvider;

    const scanner = new MarketOpportunityScanner(mockProvider);
    const result = await scanner.scan();

    // Universe had 4 items, but 1 duplicate and 1 dated future filtered out -> exactly 2 eligible
    expect(result.eligibleCount).toBe(2);
    expect(result.allQualifiedOpportunities.length).toBe(2);

    const symbols = result.allQualifiedOpportunities.map(o => o.symbol);
    expect(symbols).toContain('ETH/USDT');
    expect(symbols).toContain('SOL/USDT');
    // Ensure ETH/USDT appears only once
    expect(symbols.filter(s => s === 'ETH/USDT').length).toBe(1);

    // Verify opportunityId format matches: Instrument + Strategy + Direction
    const ethOpp = result.allQualifiedOpportunities.find(o => o.symbol === 'ETH/USDT')!;
    expect(ethOpp.opportunityId).toBe('ETH/USDT:ScalperV2:LONG');
  });

  it('strictly enforces canonical pipeline ordering: Quality Filter -> Turnover Sort -> Top 25 -> Budget Eligibility', async () => {
    // 30 qualified linear markets with descending turnover:
    // COIN1 has $30M, COIN2 has $29M, ..., COIN30 has $1M.
    // COIN1 to COIN25 form the true Top 25.
    // COIN26 to COIN30 are ranked 26 to 30.
    // Configure top 5 (COIN1..COIN5) with minNotional = 10 USDT.
    // Configure remaining 25 (COIN6..COIN30) with minNotional = 5 USDT.
    const markets = Array.from({ length: 30 }, (_, i) => ({
      id: `COIN${i + 1}USDT`,
      symbol: `COIN${i + 1}/USDT`,
      base: `COIN${i + 1}`,
      quote: 'USDT',
      active: true,
      category: 'linear',
      contractType: 'LinearPerpetual',
      precision: { price: 0.01, amount: 0.01 },
      limits: {
        cost: { min: i < 5 ? 10.0 : 5.0 }, // First 5 require $10 minNotional
        amount: { min: 0.01 }
      },
    }));

    const tickers = Array.from({ length: 30 }, (_, i) => ({
      symbol: `COIN${i + 1}/USDT`,
      last: 100.0,
      bid: 99.98,
      ask: 100.02,
      quoteVolume: (30 - i) * 1_000_000, // Descending turnover ($30M down to $1M)
      high: 102.5,
      low: 97.5,
    }));

    const fetchCandlesSpy = vi.fn().mockImplementation((_sym: string, tf: string) => {
      return Promise.resolve(generateCandles(tf as ScannerTimeframe, 60, 'BULL'));
    });

    mockProvider = {
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockResolvedValue(tickers),
      fetchCandles: fetchCandlesSpy,
    } as unknown as IExchangeProvider & ICandleProvider;

    const scanner = new MarketOpportunityScanner(mockProvider);
    // User provides strict budget = 5.0 USDT
    const result = await scanner.scan({ tradeAmountUsdt: 5.0 });

    // 1. All 30 pass quality screening
    expect(result.qualityCount).toBe(30);

    // 2. Budget gate evaluates on Top 25 (COIN1..COIN25):
    // COIN1..COIN5 fail budget ($5 < $10 minNotional)
    // COIN6..COIN25 pass budget (20 candidates)
    // COIN26..COIN30 are rank 26-30 and must NEVER be pulled in to fill the quota!
    expect(result.allQualifiedOpportunities.length).toBe(20);

    const evaluatedSymbols = result.allQualifiedOpportunities.map(o => o.symbol);

    // Assert top 5 unaffordable markets were dropped
    for (let i = 1; i <= 5; i++) {
      expect(evaluatedSymbols).not.toContain(`COIN${i}/USDT`);
    }

    // Assert affordable Top 25 candidates (COIN6..COIN25) are present
    for (let i = 6; i <= 25; i++) {
      expect(evaluatedSymbols).toContain(`COIN${i}/USDT`);
    }

    // Crucial check: COIN26..COIN30 must NOT be present (no replacement from #26+)
    for (let i = 26; i <= 30; i++) {
      expect(evaluatedSymbols).not.toContain(`COIN${i}/USDT`);
    }
  });

  it('correctly handles candidate budget boundary cases: N = 0, N = 1, N < 25, and N = 25', async () => {
    const markets = Array.from({ length: 25 }, (_, i) => ({
      id: `COIN${i + 1}USDT`,
      symbol: `COIN${i + 1}/USDT`,
      base: `COIN${i + 1}`,
      quote: 'USDT',
      active: true,
      category: 'linear',
      contractType: 'LinearPerpetual',
      precision: { price: 0.01, amount: 0.01 },
      limits: {
        cost: { min: i === 0 ? 5.0 : 10.0 }, // Only COIN1 has minNotional 5, rest have 10
        amount: { min: 0.01 }
      },
    }));

    const tickers = Array.from({ length: 25 }, (_, i) => ({
      symbol: `COIN${i + 1}/USDT`,
      last: 100.0,
      bid: 99.98,
      ask: 100.02,
      quoteVolume: (25 - i) * 1_000_000,
      high: 102.5,
      low: 97.5,
    }));

    const fetchCandlesSpy = vi.fn().mockImplementation((_sym: string, tf: string) => {
      return Promise.resolve(generateCandles(tf as ScannerTimeframe, 60, 'BULL'));
    });

    mockProvider = {
      fetchMarkets: vi.fn().mockResolvedValue(markets),
      fetchTickers: vi.fn().mockResolvedValue(tickers),
      fetchCandles: fetchCandlesSpy,
    } as unknown as IExchangeProvider & ICandleProvider;

    const scanner = new MarketOpportunityScanner(mockProvider);

    // Boundary Case N = 0: budget = 2.0 (below all minNotionals)
    const resultN0 = await scanner.scan({ tradeAmountUsdt: 2.0 });
    expect(resultN0.allQualifiedOpportunities.length).toBe(0);

    // Boundary Case N = 1: budget = 5.0 (only COIN1 is affordable)
    const resultN1 = await scanner.scan({ tradeAmountUsdt: 5.0 });
    expect(resultN1.allQualifiedOpportunities.length).toBe(1);
    expect(resultN1.allQualifiedOpportunities[0].symbol).toBe('COIN1/USDT');

    // Boundary Case N = 25: budget = 50.0 (all 25 are affordable)
    const resultN25 = await scanner.scan({ tradeAmountUsdt: 50.0 });
    expect(resultN25.allQualifiedOpportunities.length).toBe(25);
  });
});
