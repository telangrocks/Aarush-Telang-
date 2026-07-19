import { NormalizedCandle } from '../../market-data/MarketSnapshot';

export function calculateSMA(candles: NormalizedCandle[], period: number): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period || period <= 0) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += candles[i].close;
  }
  result[period - 1] = sum / period;

  for (let i = period; i < candles.length; i++) {
    sum = sum - candles[i - period].close + candles[i].close;
    result[i] = sum / period;
  }

  return result;
}
