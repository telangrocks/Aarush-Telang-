import { Timeframe } from './Timeframe';
import { NormalizedCandle } from './MarketSnapshot';
import { Ticker } from '../../exchanges/models/NormalizedDomain';

/**
 * Exchange-agnostic abstraction for retrieving market data.
 * Uses internal normalized domain models — no CCXT types cross this boundary.
 */
export interface ICandleProvider {
  /**
   * Fetch historical candles for a given symbol and timeframe.
   */
  fetchCandles(symbol: string, timeframe: Timeframe, limit?: number): Promise<NormalizedCandle[]>;

  /**
   * Fetch the latest market ticker for a given symbol.
   * Returns the normalized Ticker from the application domain — not a CCXT object.
   */
  fetchTicker(symbol: string): Promise<Ticker | null>;
}
