import { ICandleProvider } from '../../infrastructure/exchange/types';
import { MarketSnapshot } from './MarketSnapshot';
import { Timeframe } from './Timeframe';
import { CandleValidator } from '../../infrastructure/exchange/CandleValidator';
import { StructuredLogger } from '../../infrastructure/telemetry/Telemetry';

export interface MarketDataEngineOptions {
  minCandlesRequired?: number;
}

export class MarketDataEngine {
  private logger = new StructuredLogger();
  private minCandlesRequired: number;

  constructor(
    private provider: ICandleProvider,
    options?: MarketDataEngineOptions
  ) {
    this.minCandlesRequired = options?.minCandlesRequired ?? 10;
  }

  /**
   * Orchestrates the collection, normalization, and validation of market data across multiple timeframes.
   * Ensures MarketDataEngine receives identical object structure from every exchange.
   */
  private cache: Map<string, { snapshot: MarketSnapshot; expiresAt: number }> = new Map();

  public async getSnapshot(symbol: string, timeframes: Timeframe[], limit: number = 200): Promise<MarketSnapshot> {
    if (!timeframes || timeframes.length === 0) {
      throw new Error('At least one timeframe must be specified');
    }

    const cacheKey = `${symbol}_${timeframes.slice().sort().join(',')}_${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.snapshot;
    }

    // Parallel fetch: fetch ticker and all candle timeframes concurrently
    const tickerPromise = this.provider.fetchTicker(symbol);

    const candlePromises = timeframes.map(async (tf) => {
      try {
        const rawCandles = await this.provider.fetchCandles(symbol, tf, limit);
        const cleanCandles = CandleValidator.sanitizeAndSortCandles(rawCandles);

        const gaps = CandleValidator.detectMissingCandles(cleanCandles, tf);
        if (gaps.hasGaps) {
          this.logger.warn(`[MarketDataEngine] Detected timestamp gaps in ${symbol} (${tf})`, {
            symbol,
            timeframe: tf,
            missingIntervalsCount: gaps.missingIntervalsCount,
            gapStarts: gaps.gapStartTimes,
          });
        }

        const freshness = CandleValidator.validateCandleFreshness(cleanCandles, tf);
        if (!freshness.isFresh) {
          this.logger.warn(`[MarketDataEngine] Stale candles detected for ${symbol} (${tf})`, {
            symbol,
            timeframe: tf,
            ageMs: freshness.ageMs,
            lastCandleTime: freshness.lastCandleTime,
          });
        }

        return { tf, cleanCandles };
      } catch (e) {
        this.logger.error(`[MarketDataEngine] Failed to fetch candles for ${symbol} at ${tf}`, {
          symbol,
          timeframe: tf,
          error: e instanceof Error ? e.message : String(e),
        });
        throw new Error(`Failed to fetch candles for ${symbol} (${tf}): ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    const [tickerResult, candleResults] = await Promise.all([
      tickerPromise,
      Promise.allSettled(candlePromises),
    ]);

    if (!tickerResult) {
      throw new Error(`Failed to fetch market ticker for symbol: ${symbol}`);
    }

    const ticker = tickerResult;
    const toNum = (v: any) => (v && typeof v.toNumber === 'function' ? v.toNumber() : typeof v === 'number' ? v : 0);

    const snapshot: MarketSnapshot = {
      symbol: ticker.symbol,
      timestamp: Date.now(),
      currentPrice: toNum(ticker.last ?? (ticker as any).price),
      volume24h: toNum(ticker.volume ?? (ticker as any).volume24h),
      quoteVolume24h: toNum(ticker.quoteVolume ?? (ticker as any).quoteVolume24h),
      candles: {} as MarketSnapshot['candles'],
      metadata: {
        priceChange24h: toNum((ticker as any).priceChange24h ?? 0),
        priceChangePercent24h: toNum((ticker as any).priceChangePercent24h ?? 0),
        highPrice24h: toNum(ticker.high ?? (ticker as any).highPrice24h),
        lowPrice24h: toNum(ticker.low ?? (ticker as any).lowPrice24h),
      },
    };

    let successCount = 0;
    let lastError: any;

    for (let i = 0; i < timeframes.length; i++) {
      const tf = timeframes[i];
      const result = candleResults[i];

      if (result.status === 'fulfilled') {
        snapshot.candles[tf] = result.value.cleanCandles;
        successCount++;
      } else {
        snapshot.candles[tf] = [];
        lastError = result.reason;
        this.logger.warn('[MarketDataEngine] Timeframe failed, using empty candles', {
          symbol,
          timeframe: tf,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    if (successCount === 0) {
      throw new Error(
        `All timeframes failed for ${symbol}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
      );
    }

    if (successCount < timeframes.length) {
      this.logger.warn('[MarketDataEngine] Partial snapshot', {
        symbol,
        requested: timeframes.length,
        succeeded: successCount,
      });
    }

    this.cache.set(cacheKey, { snapshot, expiresAt: Date.now() + 5000 });
    return snapshot;
  }
}
