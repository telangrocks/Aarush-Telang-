import { Timeframe } from './Timeframe';
import { NormalizedCandle } from './MarketSnapshot';
import { MarketTicker } from '../../exchanges/types';

/**
 * Exchange-agnostic abstraction for retrieving market data.
 */
export interface ICandleProvider {
  /**
   * Fetch historical candles for a given symbol and timeframe.
   */
  fetchCandles(symbol: string, timeframe: Timeframe, limit?: number): Promise<NormalizedCandle[]>;

  /**
   * Fetch the latest market ticker for a given symbol.
   */
  fetchTicker(symbol: string): Promise<MarketTicker | null>;
}
