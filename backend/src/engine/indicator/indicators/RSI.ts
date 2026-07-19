import { NormalizedCandle } from '../../market-data/MarketSnapshot';

export function calculateRSI(candles: NormalizedCandle[], period: number): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  if (candles.length <= period || period <= 0) return result;

  let sumGain = 0;
  let sumLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change >= 0) {
      sumGain += change;
    } else {
      sumLoss -= change;
    }
  }

  let avgGain = sumGain / period;
  let avgLoss = sumLoss / period;

  if (avgLoss === 0) {
    result[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    result[period] = 100 - (100 / (1 + rs));
  }

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    let gain = 0;
    let loss = 0;

    if (change >= 0) {
      gain = change;
    } else {
      loss = -change;
    }

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - (100 / (1 + rs));
    }
  }

  return result;
}
