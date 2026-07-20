/**
 * Endurance.test.ts - Stress Testing Suite
 *
 * Simulates high-load conditions and malformed data scenarios.
 * Verifies the platform remains stable under duress with:
 * - Graceful HOLD on invalid/empty data
 * - Zero crashes under thousands of evaluation cycles
 * - Correct handling of malformed candles
 */

import { describe, it, expect } from 'vitest';
import { StrategyRegistry } from '../../src/engine/strategies/StrategyRegistry';
import { StrategyContext } from '../../src/engine/context/StrategyContext';

function baseSnapshot(overrides: any = {}) {
  return {
    symbol: 'BTC/USDT',
    timestamp: Date.now(),
    currentPrice: 50000,
    volume24h: 1000000,
    quoteVolume24h: 50000000000,
    metadata: { priceChange24h: 1, priceChangePercent24h: 0.5, highPrice24h: 51000, lowPrice24h: 49000 },
    candles: {
      '5m': Array.from({ length: 100 }, (_, i) => ({
        timestamp: i,
        open: 50000 + i,
        high: 50100 + i,
        low: 49900 + i,
        close: 50000 + i,
        volume: 100 + i
      })),
      '15m': Array.from({ length: 100 }, (_, i) => ({
        timestamp: i,
        open: 50000 + i,
        high: 50100 + i,
        low: 49900 + i,
        close: 50000 + i,
        volume: 100 + i
      })),
      '1h': Array.from({ length: 100 }, (_, i) => ({
        timestamp: i,
        open: 50000 + i,
        high: 50100 + i,
        low: 49900 + i,
        close: 50000 + i,
        volume: 100 + i
      }))
    } as any,
    ...overrides
  };
}

const registry = StrategyRegistry.getInstance();
const allStrategies = [...registry.getAllStrategies()];

describe('Endurance Stress Tests', () => {

  it('should complete 1000 evaluation cycles without crashing', () => {
    const snapshot = baseSnapshot();
    let errors = 0;
    for (let i = 0; i < 1000; i++) {
      try {
        const ctx = new StrategyContext(snapshot).freeze();
        for (const [, strategy] of allStrategies) {
          strategy.evaluate(ctx);
        }
      } catch {
        errors++;
      }
    }
    expect(errors).toBe(0);
  });

  it('should return HOLD for empty candle arrays', () => {
    const snapshot = baseSnapshot({
      candles: { '15m': [] }
    });
    const ctx = new StrategyContext(snapshot).freeze();

    for (const [id, strategy] of allStrategies) {
      const result = strategy.evaluate(ctx);
      expect(result.strategyId).toBeDefined();
      expect(result.hasSignal).toBe(false);
      expect(result.metadata?.reasoning?.length).toBeGreaterThan(0);
    }
  });

  it('should handle missing timeframes gracefully', () => {
    const snapshot = baseSnapshot({ candles: {} as any });
    const ctx = new StrategyContext(snapshot).freeze();
    for (const [, strategy] of allStrategies) {
      const result = strategy.evaluate(ctx);
      expect(result.hasSignal).toBe(false);
    }
  });

  it('should handle partial candle data (only 3 candles available)', () => {
    const shortCandles = [
      { timestamp: 1, open: 100, high: 105, low: 95, close: 102, volume: 100 },
      { timestamp: 2, open: 102, high: 106, low: 98, close: 104, volume: 120 },
      { timestamp: 3, open: 104, high: 108, low: 100, close: 103, volume: 90 }
    ];
    const snapshot = baseSnapshot({
      candles: { '15m': shortCandles, '1h': shortCandles }
    });
    const ctx = new StrategyContext(snapshot).freeze();
    for (const [, strategy] of allStrategies) {
      // Should not throw — graceful degradation
      expect(() => strategy.evaluate(ctx)).not.toThrow();
    }
  });

  it('should handle zero-volume candles without crashing', () => {
    const zeroVolCandles = Array.from({ length: 50 }, (_, i) => ({
      timestamp: i,
      open: 50000,
      high: 50000,
      low: 50000,
      close: 50000,
      volume: 0
    }));
    const snapshot = baseSnapshot({
      candles: { '15m': zeroVolCandles, '5m': zeroVolCandles, '1h': zeroVolCandles }
    });
    const ctx = new StrategyContext(snapshot).freeze();
    for (const [, strategy] of allStrategies) {
      expect(() => strategy.evaluate(ctx)).not.toThrow();
    }
  });

  it('should handle candles with NaN prices without crashing', () => {
    const nanCandles = Array.from({ length: 50 }, (_, i) => ({
      timestamp: i,
      open: i % 5 === 0 ? NaN : 50000,
      high: 50100,
      low: 49900,
      close: i % 3 === 0 ? NaN : 50000,
      volume: 100
    }));
    const snapshot = baseSnapshot({
      candles: { '15m': nanCandles, '5m': nanCandles, '1h': nanCandles }
    });
    const ctx = new StrategyContext(snapshot).freeze();
    for (const [, strategy] of allStrategies) {
      expect(() => strategy.evaluate(ctx)).not.toThrow();
    }
  });

  it('should evaluate 100 different symbols without degradation', () => {
    const validCandles = Array.from({ length: 100 }, (_, i) => ({
      timestamp: i,
      open: 150 + i,
      high: 155 + i,
      low: 145 + i,
      close: 152 + i,
      volume: 100 + i
    }));
    let totalHasSignalCount = 0;
    for (let i = 0; i < 100; i++) {
      const snap = baseSnapshot({
        symbol: `COIN${i}/USDT`,
        candles: { '5m': validCandles, '15m': validCandles, '1h': validCandles }
      });
      const ctx = new StrategyContext(snap).freeze();
      for (const [, strategy] of allStrategies) {
        const result = strategy.evaluate(ctx);
        expect(result.strategyId).toBeDefined();
        if (result.hasSignal) totalHasSignalCount++;
      }
    }
    // Just verify no crashes — signal count is data-dependent
    expect(totalHasSignalCount).toBeGreaterThanOrEqual(0);
  });
});
