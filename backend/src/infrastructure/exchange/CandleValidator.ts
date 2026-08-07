import { NormalizedCandle } from '../../engine/market-data/MarketSnapshot';

export interface CandleValidationResult {
  isValid: boolean;
  reason?: string;
}

export interface FreshnessResult {
  isFresh: boolean;
  ageMs: number;
  lastCandleTime: number;
}

export interface GapDetectionResult {
  hasGaps: boolean;
  missingIntervalsCount: number;
  gapStartTimes: number[];
}

export class CandleValidator {
  /**
   * Converts timeframe string (e.g. '1m', '1h', '1d') to duration in milliseconds.
   */
  public static timeframeToMs(timeframe: string): number {
    const unit = timeframe.slice(-1);
    const amount = parseInt(timeframe.slice(0, -1), 10) || 1;

    switch (unit) {
      case 'm':
        return amount * 60 * 1000;
      case 'h':
        return amount * 60 * 60 * 1000;
      case 'd':
      case 'D':
        return amount * 24 * 60 * 60 * 1000;
      case 'w':
      case 'W':
        return amount * 7 * 24 * 60 * 60 * 1000;
      default:
        return 60 * 1000; // default 1m
    }
  }

  /**
   * Validates individual candle structure and OHLC numerical bounds.
   */
  public static validateCandleStructure(candle: Partial<NormalizedCandle>): CandleValidationResult {
    if (!candle) {
      return { isValid: false, reason: 'Candle object is null or undefined' };
    }

    const { timestamp, open, high, low, close, volume } = candle;

    if (typeof timestamp !== 'number' || isNaN(timestamp) || timestamp <= 0) {
      return { isValid: false, reason: 'Invalid or non-positive timestamp' };
    }
    if (typeof open !== 'number' || isNaN(open) || open < 0) {
      return { isValid: false, reason: 'Invalid open price' };
    }
    if (typeof high !== 'number' || isNaN(high) || high < 0) {
      return { isValid: false, reason: 'Invalid high price' };
    }
    if (typeof low !== 'number' || isNaN(low) || low < 0) {
      return { isValid: false, reason: 'Invalid low price' };
    }
    if (typeof close !== 'number' || isNaN(close) || close < 0) {
      return { isValid: false, reason: 'Invalid close price' };
    }
    if (typeof volume !== 'number' || isNaN(volume) || volume < 0) {
      return { isValid: false, reason: 'Invalid volume' };
    }

    if (high < Math.max(open, close)) {
      return { isValid: false, reason: `High price (${high}) is lower than max(open, close)` };
    }
    if (low > Math.min(open, close)) {
      return { isValid: false, reason: `Low price (${low}) is higher than min(open, close)` };
    }

    return { isValid: true };
  }

  /**
   * Sanitizes, deduplicates, and sorts a list of candles in ascending order of timestamp.
   */
  public static sanitizeAndSortCandles(rawCandles: any[]): NormalizedCandle[] {
    if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
      return [];
    }

    const map = new Map<number, NormalizedCandle>();

    for (const raw of rawCandles) {
      const ts = typeof raw.timestamp === 'number' ? raw.timestamp : typeof raw.openTime === 'number' ? raw.openTime : 0;
      const candle: NormalizedCandle = {
        timestamp: ts,
        open: typeof raw.open === 'number' ? raw.open : parseFloat(raw.open || 0),
        high: typeof raw.high === 'number' ? raw.high : parseFloat(raw.high || 0),
        low: typeof raw.low === 'number' ? raw.low : parseFloat(raw.low || 0),
        close: typeof raw.close === 'number' ? raw.close : parseFloat(raw.close || 0),
        volume: typeof raw.volume === 'number' ? raw.volume : parseFloat(raw.volume || 0),
      };

      const validation = this.validateCandleStructure(candle);
      if (validation.isValid) {
        map.set(ts, candle); // Deduplicate by timestamp
      }
    }

    const sorted = Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
    return sorted;
  }

  /**
   * Detects missing candle intervals/gaps in a sorted array of candles.
   */
  public static detectMissingCandles(candles: NormalizedCandle[], timeframe: string): GapDetectionResult {
    if (candles.length <= 1) {
      return { hasGaps: false, missingIntervalsCount: 0, gapStartTimes: [] };
    }

    const tfMs = this.timeframeToMs(timeframe);
    const gapStartTimes: number[] = [];
    let missingIntervalsCount = 0;

    for (let i = 1; i < candles.length; i++) {
      const diff = candles[i].timestamp - candles[i - 1].timestamp;
      if (diff > tfMs * 1.5) {
        const missingCount = Math.round(diff / tfMs) - 1;
        missingIntervalsCount += missingCount;
        gapStartTimes.push(candles[i - 1].timestamp);
      }
    }

    return {
      hasGaps: gapStartTimes.length > 0,
      missingIntervalsCount,
      gapStartTimes,
    };
  }

  /**
   * Validates if the candle set is fresh (latest candle timestamp within threshold).
   */
  public static validateCandleFreshness(
    candles: NormalizedCandle[],
    timeframe: string,
    maxAllowedMultiplier = 3
  ): FreshnessResult {
    if (candles.length === 0) {
      return { isFresh: false, ageMs: Infinity, lastCandleTime: 0 };
    }

    const lastCandle = candles[candles.length - 1];
    const tfMs = this.timeframeToMs(timeframe);
    const maxAgeMs = tfMs * maxAllowedMultiplier;
    const now = Date.now();
    const ageMs = now - lastCandle.timestamp;

    return {
      isFresh: ageMs <= maxAgeMs,
      ageMs,
      lastCandleTime: lastCandle.timestamp,
    };
  }
}
