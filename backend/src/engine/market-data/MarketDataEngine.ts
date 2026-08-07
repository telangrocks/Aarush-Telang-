import { ICandleProvider } from './CandleProvider';
import { MarketSnapshot } from './MarketSnapshot';
import { Timeframe } from './Timeframe';
import { CandleValidator } from '../../infrastructure/exchange/CandleValidator';
import { StructuredLogger } from '../../infrastructure/telemetry/Telemetry';

export class MarketDataEngine {
  private logger = new StructuredLogger();

  constructor(private provider: ICandleProvider) {}

  /**
   * Orchestrates the collection, normalization, and validation of market data across multiple timeframes.
   * Ensures MarketDataEngine receives identical object structure from every exchange.
   */
  public async getSnapshot(symbol: string, timeframes: Timeframe[]): Promise<MarketSnapshot> {
    if (!timeframes || timeframes.length === 0) {
      throw new Error('At least one timeframe must be specified');
    }

    const ticker = await this.provider.fetchTicker(symbol);
    if (!ticker) {
      throw new Error(`Failed to fetch market ticker for symbol: ${symbol}`);
    }

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
      }
    };

    // Fetch and validate candles concurrently
    const promises = timeframes.map(async (tf) => {
      try {
        const rawCandles = await this.provider.fetchCandles(symbol, tf);
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

        snapshot.candles[tf] = cleanCandles;
      } catch (e) {
        this.logger.error(`[MarketDataEngine] Failed to fetch candles for ${symbol} at ${tf}`, {
          symbol,
          timeframe: tf,
          error: e instanceof Error ? e.message : String(e),
        });
        throw new Error(`Failed to retrieve authentic market candle statistics for ${symbol} (${tf}): ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    await Promise.all(promises);

    return snapshot;
  }
}
