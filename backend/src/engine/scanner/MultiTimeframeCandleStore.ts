import { ICandleProvider } from '../../infrastructure/exchange/types';
import { MarketSnapshot, NormalizedCandle } from '../market-data/MarketSnapshot';
import { CandleValidator } from '../../infrastructure/exchange/CandleValidator';
import { Timeframe } from '../market-data/Timeframe';
import { ExchangeRequestScheduler, RequestPriority } from '../../infrastructure/exchange/pacing';

export type ScannerTimeframe = '4h' | '1h' | '15m' | '5m' | '1m';

export interface StoredCandleSeries {
  readonly symbol: string;
  readonly timeframe: ScannerTimeframe;
  readonly candles: NormalizedCandle[];
  readonly fetchedAt: number;
  readonly expiresAt: number;
  readonly isFresh: boolean;
  readonly hasGaps: boolean;
  readonly isDegraded: boolean;
  readonly degradationReason?: string;
}

export interface MultiTimeframeSnapshot {
  readonly symbol: string;
  readonly timeframes: Partial<Record<ScannerTimeframe, StoredCandleSeries>>;
  readonly isFullyDegraded: boolean;
  readonly availableTimeframes: ScannerTimeframe[];
}

/**
 * Cache TTL configuration aligned with candle closure intervals.
 * Higher timeframes are cached longer to minimize redundant subrequests.
 */
const TIMEFRAME_TTL_MS: Record<ScannerTimeframe, number> = {
  '4h': 15 * 60 * 1000,   // 15 minutes
  '1h': 5 * 60 * 1000,    // 5 minutes
  '15m': 60 * 1000,       // 1 minute
  '5m': 15 * 1000,        // 15 seconds
  '1m': 15 * 1000,        // 15 seconds
};

export class MultiTimeframeCandleStore {
  private cache = new Map<string, StoredCandleSeries>();

  constructor(
    private readonly provider: ICandleProvider,
    private readonly maxCandlesPerTimeframe: number = 70,
    private readonly scheduler?: ExchangeRequestScheduler
  ) {}

  private getCacheKey(symbol: string, tf: ScannerTimeframe): string {
    return `${symbol}:${tf}`;
  }

  /**
   * Retrieves or fetches a single timeframe series with caching and integrity validation.
   */
  public async getSeries(
    symbol: string,
    tf: ScannerTimeframe,
    forceRefresh: boolean = false
  ): Promise<StoredCandleSeries> {
    const key = this.getCacheKey(symbol, tf);
    const cached = this.cache.get(key);

    if (!forceRefresh && cached && Date.now() < cached.expiresAt) {
      return cached;
    }

    try {
      const limit = Math.min(this.maxCandlesPerTimeframe, 70);

      const fetchFn = async () => {
        if (typeof (this.provider as any).fetchCandles === 'function') {
          return await (this.provider as any).fetchCandles(symbol, tf as Timeframe, limit);
        } else if (typeof (this.provider as any).fetchKlines === 'function') {
          return await (this.provider as any).fetchKlines(symbol, tf, limit);
        }
        return [];
      };

      let raw: any[] = [];
      if (this.scheduler) {
        raw = await this.scheduler.schedule(RequestPriority.P3_MARKET_DATA, fetchFn);
      } else {
        raw = await fetchFn();
      }
      const clean = CandleValidator.sanitizeAndSortCandles(raw);

      if (clean.length === 0) {
        return {
          symbol,
          timeframe: tf,
          candles: [],
          fetchedAt: Date.now(),
          expiresAt: Date.now() + 10_000, // short cache for empty/failed
          isFresh: false,
          hasGaps: true,
          isDegraded: true,
          degradationReason: `No candles returned from exchange for ${symbol} (${tf})`,
        };
      }

      // Check for timestamp gaps
      const gapResult = CandleValidator.detectMissingCandles(clean, tf);
      // Check freshness
      const freshnessResult = CandleValidator.validateCandleFreshness(clean, tf);

      const isDegraded = gapResult.missingIntervalsCount > 3 || !freshnessResult.isFresh;
      const degradationReason = isDegraded
        ? `Gaps: ${gapResult.missingIntervalsCount}, Age: ${freshnessResult.ageMs}ms`
        : undefined;

      const ttl = TIMEFRAME_TTL_MS[tf] ?? 60_000;
      const stored: StoredCandleSeries = {
        symbol,
        timeframe: tf,
        candles: clean,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + ttl,
        isFresh: freshnessResult.isFresh,
        hasGaps: gapResult.hasGaps,
        isDegraded,
        degradationReason,
      };

      this.cache.set(key, stored);
      return stored;
    } catch (err: any) {
      return {
        symbol,
        timeframe: tf,
        candles: [],
        fetchedAt: Date.now(),
        expiresAt: Date.now() + 10_000,
        isFresh: false,
        hasGaps: true,
        isDegraded: true,
        degradationReason: err?.message || String(err),
      };
    }
  }

  /**
   * Retrieves snapshots across specified hierarchical timeframes with bounded concurrency.
   */
  public async getMultiTimeframeSnapshot(
    symbol: string,
    timeframes: ScannerTimeframe[],
    forceRefresh: boolean = false
  ): Promise<MultiTimeframeSnapshot> {
    const results = await Promise.all(
      timeframes.map(tf => this.getSeries(symbol, tf, forceRefresh))
    );

    const tfMap: Partial<Record<ScannerTimeframe, StoredCandleSeries>> = {};
    const available: ScannerTimeframe[] = [];
    let degradedCount = 0;

    for (const res of results) {
      tfMap[res.timeframe] = res;
      if (!res.isDegraded && res.candles.length > 0) {
        available.push(res.timeframe);
      } else {
        degradedCount++;
      }
    }

    const isFullyDegraded = degradedCount === timeframes.length;

    return {
      symbol,
      timeframes: tfMap,
      isFullyDegraded,
      availableTimeframes: available,
    };
  }

  /**
   * Directly sets or primes the cache for a given symbol and timeframe.
   * Strictly in-memory: enables mocking and zero-network fixture loading.
   */
  public setSeries(symbol: string, tf: ScannerTimeframe, series: StoredCandleSeries): void {
    this.cache.set(this.getCacheKey(symbol, tf), series);
  }

  /**
   * Read-only export of cached multi-timeframe candle snapshot.
   * Strictly in-memory: makes ZERO network or provider calls.
   * If scanCutoffTs is provided, filters candles to candle close <= scanCutoffTs.
   */
  public exportSnapshot(
    symbol: string,
    timeframes: readonly (ScannerTimeframe | Timeframe)[] | (ScannerTimeframe | Timeframe)[],
    scanCutoffTs?: number
  ): MultiTimeframeSnapshot {
    const tfMap: Partial<Record<ScannerTimeframe, StoredCandleSeries>> = {};
    const available: ScannerTimeframe[] = [];
    let degradedCount = 0;

    const validScannerTimeframes: ScannerTimeframe[] = [];
    for (const tf of timeframes) {
      if (tf === '4h' || tf === '1h' || tf === '15m' || tf === '5m' || tf === '1m') {
        validScannerTimeframes.push(tf);
      }
    }

    for (const tf of validScannerTimeframes) {
      const key = this.getCacheKey(symbol, tf);
      const cached = this.cache.get(key);
      if (cached) {
        let candles = cached.candles;
        if (scanCutoffTs !== undefined) {
          candles = candles.filter((c) => {
            const close =
              (c as any).closeTime ??
              ((c.openTime ?? c.timestamp ?? 0) + CandleValidator.timeframeToMs(tf));
            return close <= scanCutoffTs;
          });
        }
        const series: StoredCandleSeries = {
          ...cached,
          candles,
        };
        tfMap[tf] = series;
        if (!series.isDegraded && series.candles.length > 0) {
          available.push(tf);
        } else {
          degradedCount++;
        }
      } else {
        degradedCount++;
      }
    }

    return {
      symbol,
      timeframes: tfMap,
      isFullyDegraded: validScannerTimeframes.length === 0 || degradedCount === validScannerTimeframes.length,
      availableTimeframes: available,
    };
  }

  /**
   * Exports an in-memory MarketSnapshot directly consumable by StrategyContext.
   * Strictly in-memory: makes ZERO network or provider calls.
   */
  public exportMarketSnapshot(
    symbol: string,
    timeframes: readonly (ScannerTimeframe | Timeframe)[] | (ScannerTimeframe | Timeframe)[] = ['5m', '15m', '1h', '4h'],
    currentPrice?: number,
    scanCutoffTs?: number
  ): MarketSnapshot {
    const snapshot = this.exportSnapshot(symbol, timeframes, scanCutoffTs);
    const candlesRecord: Record<Timeframe, NormalizedCandle[]> = {
      '1m': snapshot.timeframes['1m']?.candles || [],
      '3m': [],
      '5m': snapshot.timeframes['5m']?.candles || [],
      '15m': snapshot.timeframes['15m']?.candles || [],
      '30m': [],
      '1h': snapshot.timeframes['1h']?.candles || [],
      '4h': snapshot.timeframes['4h']?.candles || [],
    };

    let resolvedPrice = currentPrice || 0;
    if (!resolvedPrice) {
      const pCandles =
        candlesRecord['15m'].length > 0
          ? candlesRecord['15m']
          : candlesRecord['5m'].length > 0
          ? candlesRecord['5m']
          : candlesRecord['1h'];
      if (pCandles && pCandles.length > 0) {
        resolvedPrice = pCandles[pCandles.length - 1].close;
      }
    }

    return {
      symbol,
      timestamp: scanCutoffTs ?? Date.now(),
      currentPrice: resolvedPrice,
      volume24h: 0,
      quoteVolume24h: 0,
      candles: candlesRecord,
      metadata: {
        priceChange24h: 0,
        priceChangePercent24h: 0,
        highPrice24h: resolvedPrice,
        lowPrice24h: resolvedPrice,
      },
    };
  }

  /**
   * Clears expired entries to manage memory in long-running isolates.
   */
  public purgeExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.cache.entries()) {
      if (now > v.expiresAt) {
        this.cache.delete(k);
      }
    }
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }
}
