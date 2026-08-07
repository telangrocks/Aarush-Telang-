import { NormalizedCandle } from '../../../engine/market-data/MarketSnapshot';

/**
 * Shared utility for sanitizing, deduplicating, and sorting candles ascending by openTime.
 * Removes NaN/invalid price values, invalid OHLC bounds, and deduplicates by openTime/timestamp.
 */
export function normalizeCandles(rawCandles: any[]): NormalizedCandle[] {
  if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
    return [];
  }

  const map = new Map<number, NormalizedCandle>();

  for (const raw of rawCandles) {
    if (!raw) continue;

    const openTime =
      typeof raw.openTime === 'number' && !isNaN(raw.openTime)
        ? raw.openTime
        : typeof raw.timestamp === 'number' && !isNaN(raw.timestamp)
        ? raw.timestamp
        : typeof raw[0] === 'number'
        ? raw[0]
        : 0;

    const open = typeof raw.open === 'number' ? raw.open : parseFloat(raw.open || raw[1] || 0);
    const high = typeof raw.high === 'number' ? raw.high : parseFloat(raw.high || raw[2] || 0);
    const low = typeof raw.low === 'number' ? raw.low : parseFloat(raw.low || raw[3] || 0);
    const close = typeof raw.close === 'number' ? raw.close : parseFloat(raw.close || raw[4] || 0);
    const volume = typeof raw.volume === 'number' ? raw.volume : parseFloat(raw.volume || raw[5] || 0);

    if (openTime <= 0 || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume)) {
      continue;
    }

    if (open < 0 || high < 0 || low < 0 || close < 0 || volume < 0) {
      continue;
    }

    if (high < Math.max(open, close) || low > Math.min(open, close)) {
      continue;
    }

    const candle: NormalizedCandle = {
      openTime,
      timestamp: openTime,
      open,
      high,
      low,
      close,
      volume,
    };

    map.set(openTime, candle);
  }

  return Array.from(map.values()).sort((a, b) => a.openTime - b.openTime);
}
