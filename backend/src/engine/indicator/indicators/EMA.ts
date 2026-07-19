import { NormalizedCandle } from '../../market-data/MarketSnapshot';
import { calculateSMA } from './SMA';

export function calculateEMA(candles: NormalizedCandle[], period: number): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period || period <= 0) return result;

  const k = 2 / (period + 1);
  
  // EMA requires an initial SMA to start
  const initialSMA = calculateSMA(candles.slice(0, period), period)[period - 1];
  result[period - 1] = initialSMA;

  for (let i = period; i < candles.length; i++) {
    result[i] = candles[i].close * k + result[i - 1] * (1 - k);
  }

  return result;
}
