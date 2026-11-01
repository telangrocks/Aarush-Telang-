import { NormalizedCandle } from '../../market-data/MarketSnapshot';

export class VWAPCalculator {
  /**
   * Calculates the Volume Weighted Average Price (VWAP) for an array of candles.
   * Standard VWAP resets on a new session (e.g., daily), but for this isolated engine evaluation
   * based purely on the provided candlestick array, we calculate a cumulative VWAP over the given window.
   *
   * Defensive validation rules:
   * 1. Requires a non-empty array of valid candle objects.
   * 2. High, Low, Close (and Open if present) must be positive, finite numbers.
   * 3. High >= Low, and Close/Open must reside within [Low, High] bounds.
   * 4. Volume must be a finite, non-negative number (>= 0).
   * 5. Cumulative volume across the entire window must be strictly positive (> 0).
   * If any candle fails validation or cumulative volume is 0, fails closed and returns [].
   *
   * @param candles The array of candles ordered by time (oldest first).
   * @returns An array of VWAP values corresponding to each candle, or [] on invalid inputs.
   */
  public static calculate(candles: NormalizedCandle[]): number[] {
    if (!candles || !Array.isArray(candles) || candles.length === 0) {
      return [];
    }

    const vwapValues: number[] = [];
    let cumulativeVolume = 0;
    let cumulativeTypicalPriceVolume = 0;

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      if (!candle || typeof candle !== 'object') {
        return [];
      }

      const high = candle.high;
      const low = candle.low;
      const close = candle.close;
      const volume = candle.volume;

      // Validate numeric finite positive price components
      if (typeof high !== 'number' || !Number.isFinite(high) || high <= 0) {
        return [];
      }
      if (typeof low !== 'number' || !Number.isFinite(low) || low <= 0) {
        return [];
      }
      if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) {
        return [];
      }

      // Check OHLC structural invariants (High >= Low, Close within bounds)
      if (high < low) {
        return [];
      }
      if (close < low - 1e-8 || close > high + 1e-8) {
        return [];
      }

      // If open is specified, validate open as well
      const open = candle.open;
      if (open !== undefined) {
        if (typeof open !== 'number' || !Number.isFinite(open) || open <= 0) {
          return [];
        }
        if (open < low - 1e-8 || open > high + 1e-8) {
          return [];
        }
      }

      // Validate non-negative finite volume
      if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0) {
        return [];
      }

      const typicalPrice = (high + low + close) / 3;
      if (!Number.isFinite(typicalPrice) || typicalPrice <= 0) {
        return [];
      }

      cumulativeVolume += volume;
      cumulativeTypicalPriceVolume += (typicalPrice * volume);

      if (cumulativeVolume === 0) {
        vwapValues.push(typicalPrice); // Fallback for initial 0-volume candles
      } else {
        const vwap = cumulativeTypicalPriceVolume / cumulativeVolume;
        if (!Number.isFinite(vwap) || vwap <= 0) {
          return [];
        }
        vwapValues.push(vwap);
      }
    }

    // Cumulative volume must be strictly positive across the evaluation dataset
    if (cumulativeVolume <= 0) {
      return [];
    }

    return vwapValues;
  }
}
