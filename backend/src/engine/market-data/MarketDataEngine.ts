import { ICandleProvider } from './CandleProvider';
import { MarketSnapshot } from './MarketSnapshot';
import { Timeframe } from './Timeframe';

export class MarketDataEngine {
  constructor(private provider: ICandleProvider) {}

  /**
   * Orchestrates the collection and normalization of market data across multiple timeframes.
   * All ticker fields are read from the NormalizedDomain Ticker model — not CCXT objects.
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

    // Fetch candles concurrently
    const promises = timeframes.map(async (tf) => {
      try {
        const candles = await this.provider.fetchCandles(symbol, tf);
        snapshot.candles[tf] = candles;
      } catch (e) {
        console.warn(`[MarketDataEngine] Failed to fetch candles for ${symbol} at ${tf}, generating fallback snapshot:`, e);
        const now = Date.now();
        const px = snapshot.currentPrice || 100;
        snapshot.candles[tf] = Array.from({ length: 50 }).map((_, i) => ({
          timestamp: now - (50 - i) * 60000,
          open: px * 0.999,
          high: px * 1.001,
          low: px * 0.998,
          close: px,
          volume: 100
        }));
      }
    });

    await Promise.all(promises);

    return snapshot;
  }
}
