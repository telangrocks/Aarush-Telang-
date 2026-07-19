import { NormalizedCandle } from '../../market-data/MarketSnapshot';
import { calculateEMA } from './EMA';
import { MACDResult } from '../IndicatorTypes';

export function calculateMACD(candles: NormalizedCandle[], fastPeriod: number, slowPeriod: number, signalPeriod: number): MACDResult[] {
  const result: MACDResult[] = new Array(candles.length).fill(null).map(() => ({
    macdLine: NaN,
    signalLine: NaN,
    histogram: NaN
  }));

  if (candles.length < slowPeriod || fastPeriod >= slowPeriod) return result;

  const fastEMA = calculateEMA(candles, fastPeriod);
  const slowEMA = calculateEMA(candles, slowPeriod);

  // MACD Line = Fast EMA - Slow EMA
  const macdLines: number[] = new Array(candles.length).fill(NaN);
  for (let i = slowPeriod - 1; i < candles.length; i++) {
    macdLines[i] = fastEMA[i] - slowEMA[i];
    result[i].macdLine = macdLines[i];
  }

  // Signal Line = EMA of MACD Line
  // To calculate EMA of MACD line, we construct a fake candle array
  const macdCandles: NormalizedCandle[] = macdLines.map((val, i) => ({
    timestamp: candles[i].timestamp,
    open: val,
    high: val,
    low: val,
    close: val,
    volume: 0
  }));

  // We can only start calculating signal line after we have enough macdLine points
  // Wait, `calculateEMA` handles NaN if we pass the sliced array
  const validMacdCandles = macdCandles.slice(slowPeriod - 1);
  const signalEMA = calculateEMA(validMacdCandles, signalPeriod);

  for (let i = 0; i < signalEMA.length; i++) {
    const originalIndex = i + slowPeriod - 1;
    result[originalIndex].signalLine = signalEMA[i];
    if (!isNaN(signalEMA[i])) {
      result[originalIndex].histogram = result[originalIndex].macdLine - signalEMA[i];
    }
  }

  return result;
}
