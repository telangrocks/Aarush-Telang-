import { describe, it, expect } from 'vitest';
import { CandleValidator } from './CandleValidator';
import { NormalizedCandle } from '../../engine/market-data/MarketSnapshot';

describe('CandleValidator Unit Tests', () => {
  it('validates correct candle structures', () => {
    const valid: NormalizedCandle = {
      timestamp: 1600000000000,
      open: 100,
      high: 105,
      low: 98,
      close: 102,
      volume: 50,
    };
    expect(CandleValidator.validateCandleStructure(valid).isValid).toBe(true);
  });

  it('rejects invalid OHLC bounds (high < max(open, close))', () => {
    const invalid: NormalizedCandle = {
      timestamp: 1600000000000,
      open: 100,
      high: 99, // Invalid! high is less than open
      low: 95,
      close: 98,
      volume: 10,
    };
    const res = CandleValidator.validateCandleStructure(invalid);
    expect(res.isValid).toBe(false);
    expect(res.reason).toContain('High price');
  });

  it('rejects invalid OHLC bounds (low > min(open, close))', () => {
    const invalid: NormalizedCandle = {
      timestamp: 1600000000000,
      open: 100,
      high: 110,
      low: 102, // Invalid! low is greater than open
      close: 105,
      volume: 10,
    };
    const res = CandleValidator.validateCandleStructure(invalid);
    expect(res.isValid).toBe(false);
    expect(res.reason).toContain('Low price');
  });

  it('sanitizes, deduplicates, and sorts raw candles', () => {
    const raw = [
      { timestamp: 1600000060000, open: 102, high: 106, low: 101, close: 104, volume: 20 },
      { timestamp: 1600000000000, open: 100, high: 105, low: 98, close: 102, volume: 50 },
      { timestamp: 1600000000000, open: 100, high: 105, low: 98, close: 102, volume: 50 }, // duplicate
      { timestamp: 1600000120000, open: 104, high: 99, low: 90, close: 95, volume: 10 }, // invalid high < open
    ];

    const clean = CandleValidator.sanitizeAndSortCandles(raw);
    expect(clean.length).toBe(2);
    expect(clean[0].timestamp).toBe(1600000000000);
    expect(clean[1].timestamp).toBe(1600000060000);
  });

  it('detects timestamp gaps between candles', () => {
    const candles: NormalizedCandle[] = [
      { timestamp: 1600000000000, open: 100, high: 105, low: 98, close: 102, volume: 50 },
      { timestamp: 1600000060000, open: 102, high: 106, low: 101, close: 104, volume: 20 }, // +1m
      { timestamp: 1600000240000, open: 104, high: 108, low: 103, close: 107, volume: 30 }, // +3m (gap of 2 mins)
    ];

    const gapResult = CandleValidator.detectMissingCandles(candles, '1m');
    expect(gapResult.hasGaps).toBe(true);
    expect(gapResult.missingIntervalsCount).toBe(2);
    expect(gapResult.gapStartTimes).toEqual([1600000060000]);
  });

  it('evaluates candle freshness based on max allowed age', () => {
    const now = Date.now();
    const freshCandles: NormalizedCandle[] = [
      { timestamp: now - 30000, open: 100, high: 105, low: 98, close: 102, volume: 50 },
    ];
    const staleCandles: NormalizedCandle[] = [
      { timestamp: now - 3600000, open: 100, high: 105, low: 98, close: 102, volume: 50 },
    ];

    expect(CandleValidator.validateCandleFreshness(freshCandles, '1m', 3).isFresh).toBe(true);
    expect(CandleValidator.validateCandleFreshness(staleCandles, '1m', 3).isFresh).toBe(false);
  });
});
