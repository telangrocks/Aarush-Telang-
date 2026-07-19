import { ICandleProvider } from './CandleProvider';
import { MarketSnapshot } from './MarketSnapshot';
import { Timeframe } from './Timeframe';

export class MarketDataEngine {
  constructor(private provider: ICandleProvider) {}

  /**
   * Orchestrates the collection and normalization of market data across multiple timeframes.
   */
  public async getSnapshot(symbol: string, timeframes: Timeframe[]): Promise<MarketSnapshot> {
    if (!timeframes || timeframes.length === 0) {
      throw new Error('At least one timeframe must be specified');
    }

    const ticker = await this.provider.fetchTicker(symbol);
    if (!ticker) {
      throw new Error(`Failed to fetch market ticker for symbol: ${symbol}`);
    }

    const snapshot: MarketSnapshot = {
      symbol: ticker.symbol,
      timestamp: Date.now(),
      currentPrice: ticker.price,
      volume24h: ticker.volume24h,
      quoteVolume24h: ticker.quoteVolume24h,
      candles: {} as MarketSnapshot['candles'],
      metadata: {
        priceChange24h: ticker.priceChange24h,
        priceChangePercent24h: ticker.priceChangePercent24h,
        highPrice24h: ticker.highPrice24h,
        lowPrice24h: ticker.lowPrice24h
      }
    };

    // Fetch candles concurrently
    const promises = timeframes.map(async (tf) => {
      try {
        const candles = await this.provider.fetchCandles(symbol, tf);
        snapshot.candles[tf] = candles;
      } catch (e) {
        console.error(`[MarketDataEngine] Failed to fetch candles for ${symbol} at ${tf}`, e);
        throw e;
      }
    });

    await Promise.all(promises);

    return snapshot;
  }
}
