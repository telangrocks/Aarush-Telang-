import { NormalizedCandle } from '../../market-data/MarketSnapshot';

export class VWAPCalculator {
  /**
   * Calculates the Volume Weighted Average Price (VWAP) for an array of candles.
   * Standard VWAP resets on a new session (e.g., daily), but for this isolated engine evaluation
   * based purely on the provided candlestick array, we calculate a cumulative VWAP over the given window.
   * @param candles The array of candles ordered by time (oldest first).
   * @returns An array of VWAP values corresponding to each candle.
   */
  public static calculate(candles: NormalizedCandle[]): number[] {
    if (!candles || candles.length === 0) {
      return [];
    }

    const vwapValues: number[] = [];
    let cumulativeVolume = 0;
    let cumulativeTypicalPriceVolume = 0;

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      
      cumulativeVolume += candle.volume;
      cumulativeTypicalPriceVolume += (typicalPrice * candle.volume);

      if (cumulativeVolume === 0) {
        vwapValues.push(typicalPrice); // Fallback if 0 volume
      } else {
        vwapValues.push(cumulativeTypicalPriceVolume / cumulativeVolume);
      }
    }

    return vwapValues;
  }
}
