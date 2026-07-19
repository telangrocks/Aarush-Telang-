import { Timeframe } from './Timeframe';

/**
 * A normalized candle (OHLCV) independent of any specific exchange format.
 */
export interface NormalizedCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Canonical representation of the market state at a specific point in time.
 * This is the sole source of truth for the StrategyContext.
 */
export interface MarketSnapshot {
  symbol: string;
  timestamp: number;
  currentPrice: number;
  volume24h: number;
  quoteVolume24h: number;
  candles: Record<Timeframe, NormalizedCandle[]>;
  metadata: {
    priceChange24h: number;
    priceChangePercent24h: number;
    highPrice24h: number;
    lowPrice24h: number;
  };
}
