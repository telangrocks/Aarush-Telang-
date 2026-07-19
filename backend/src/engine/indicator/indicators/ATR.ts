import { NormalizedCandle } from '../../market-data/MarketSnapshot';
import { calculateSMA } from './SMA';

export function calculateATR(candles: NormalizedCandle[], period: number): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  if (candles.length <= period || period <= 0) return result;

  const trueRanges: number[] = new Array(candles.length).fill(NaN);

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr1 = high - low;
    const tr2 = Math.abs(high - prevClose);
    const tr3 = Math.abs(low - prevClose);

    trueRanges[i] = Math.max(tr1, tr2, tr3);
  }

  // The first ATR is the SMA of the first 'period' True Ranges.
  // Note: trueRanges[0] is NaN, so we take from index 1 to period (inclusive) -> length = period
  const initialTRs = trueRanges.slice(1, period + 1);
  let sum = 0;
  for (const tr of initialTRs) {
    sum += tr;
  }
  let currentATR = sum / period;
  result[period] = currentATR;

  // Smoothing for subsequent values: ATR_t = ((ATR_t-1 * (period - 1)) + TR_t) / period
  for (let i = period + 1; i < candles.length; i++) {
    currentATR = ((currentATR * (period - 1)) + trueRanges[i]) / period;
    result[i] = currentATR;
  }

  return result;
}
