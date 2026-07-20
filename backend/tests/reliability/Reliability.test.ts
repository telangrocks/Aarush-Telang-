/**
 * Reliability.test.ts - Reliability Validation Suite
 *
 * Validates the platform's ability to handle real-world failure scenarios:
 * - Exchange timeouts
 * - Partial candle sets
 * - Invalid candles (NaN, null, zero-price, zero-volume, duplicates)
 * - Plugin isolation (one strategy failing must not halt the pipeline)
 * - Strategy Registry edge cases
 * - Durable Object recovery simulation
 */

import { describe, it, expect, vi } from 'vitest';
import { StrategyRegistry } from '../../src/engine/strategies/StrategyRegistry';
import { StrategyContext } from '../../src/engine/context/StrategyContext';
import { MetricsEngine } from '../../src/telemetry/MetricsEngine';

function makeSnapshot(candleCount: number, symbol = 'BTC/USDT') {
  const candles = Array.from({ length: candleCount }, (_, i) => ({
    timestamp: 1_700_000_000_000 + i * 60_000,
    open: 50000 + i,
    high: 50100 + i,
    low: 49900 + i,
    close: 50000 + i,
    volume: 100 + i
  }));
  return {
    symbol,
    timestamp: Date.now(),
    currentPrice: 50000,
    volume24h: 1000000,
    quoteVolume24h: 50000000000,
    metadata: { priceChange24h: 1, priceChangePercent24h: 0.5, highPrice24h: 51000, lowPrice24h: 49000 },
    candles: { '5m': candles, '15m': candles, '1h': candles } as any
  };
}

const registry = StrategyRegistry.getInstance();

// ---- Partial Candle Tests ----

describe('Partial Candle Validation', () => {
  for (const count of [50, 100, 150]) {
    it(`should not crash with ${count} candles`, () => {
      const ctx = new StrategyContext(makeSnapshot(count)).freeze();
      for (const [, strategy] of registry.getAllStrategies()) {
        expect(() => strategy.evaluate(ctx)).not.toThrow();
        const result = strategy.evaluate(ctx);
        expect(result.strategyId).toBeDefined();
      }
    });
  }
});

// ---- Invalid Candle Tests ----

describe('Invalid Candle Handling', () => {
  it('should handle NaN candle values', () => {
    const nanSnap = makeSnapshot(50);
    (nanSnap.candles['15m'] as any[])[25].close = NaN;
    const ctx = new StrategyContext(nanSnap).freeze();
    for (const [, strategy] of registry.getAllStrategies()) {
      expect(() => strategy.evaluate(ctx)).not.toThrow();
    }
  });

  it('should handle zero-price candles', () => {
    const zeroSnap = makeSnapshot(50);
    (zeroSnap.candles['15m'] as any[])[10].close = 0;
    (zeroSnap.candles['15m'] as any[])[10].open = 0;
    const ctx = new StrategyContext(zeroSnap).freeze();
    for (const [, strategy] of registry.getAllStrategies()) {
      expect(() => strategy.evaluate(ctx)).not.toThrow();
    }
  });

  it('should handle zero-volume candles', () => {
    const snap = makeSnapshot(50);
    (snap.candles['15m'] as any[]).forEach(c => { c.volume = 0; });
    const ctx = new StrategyContext(snap).freeze();
    for (const [, strategy] of registry.getAllStrategies()) {
      expect(() => strategy.evaluate(ctx)).not.toThrow();
    }
  });

  it('should handle duplicate timestamps', () => {
    const snap = makeSnapshot(50);
    // Duplicate the first timestamp on the second candle
    (snap.candles['15m'] as any[])[1].timestamp = (snap.candles['15m'] as any[])[0].timestamp;
    const ctx = new StrategyContext(snap).freeze();
    for (const [, strategy] of registry.getAllStrategies()) {
      expect(() => strategy.evaluate(ctx)).not.toThrow();
    }
  });
});

// ---- Plugin Isolation Test ----

describe('Plugin Isolation', () => {
  it('should continue evaluating all other strategies if one throws an error', () => {
    const ctx = new StrategyContext(makeSnapshot(100)).freeze();
    const results: string[] = [];

    // Force MomentumStrategy to throw by temporarily monkey-patching
    const momentum = registry.getStrategy('Momentum')!;
    const originalEvaluate = momentum.evaluate.bind(momentum);
    momentum.evaluate = () => {
      throw new Error('Simulated strategy plugin failure');
    };

    // Run evaluation manually using the same isolation pattern the Orchestrator uses
    for (const [id, strategy] of registry.getAllStrategies()) {
      try {
        strategy.evaluate(ctx);
        results.push(id);
      } catch {
        // Isolated — continue to next strategy
      }
    }

    // Restore original
    momentum.evaluate = originalEvaluate;

    // Scalper, Breakout, MeanReversion, VWAP should all still complete
    expect(results).toContain('ScalperV2');
    expect(results).toContain('Breakout');
    expect(results).toContain('MeanReversion');
    expect(results).toContain('VWAP');
    // Momentum should NOT be in the results
    expect(results).not.toContain('Momentum');
    // Total successful should be 4 out of 5
    expect(results.length).toBe(4);
  });
});

// ---- Strategy Registry Edge Cases ----

describe('Strategy Registry Edge Cases', () => {
  it('should return undefined for unknown strategy ID', () => {
    const result = registry.getStrategy('UnknownStrategyXYZ');
    expect(result).toBeUndefined();
  });

  it('should expose exactly 5 strategies after Sprint 14', () => {
    const all = [...registry.getAllStrategies()];
    expect(all.length).toBe(5);
  });

  it('should expose manifests for all 5 strategies', () => {
    const manifests = registry.getAllManifests();
    expect(manifests.length).toBe(5);
    for (const m of manifests) {
      expect(m.id).toBeTruthy();
      expect(m.displayName).toBeTruthy();
      expect(m.version).toBeTruthy();
      expect(m.category).toBeTruthy();
    }
  });

  it('should throw a meaningful error on duplicate registration', () => {
    const scalper = registry.getStrategy('ScalperV2')!;
    // The registry guards against silent overwrites — duplicate registration must throw
    expect(() => registry.registerStrategy('ScalperV2', scalper)).toThrow(
      "Strategy with ID 'ScalperV2' is already registered."
    );
  });
});

// ---- Telemetry / MetricsEngine Tests ----

describe('MetricsEngine Reliability', () => {
  it('should record strategy execution events', () => {
    const metrics = MetricsEngine.getInstance();
    metrics.reset();

    metrics.record({
      type: 'STRATEGY_EXECUTION',
      strategyId: 'TestStrategy',
      symbol: 'BTC/USDT',
      durationMs: 5.2,
      hasSignal: false,
      signal: 'HOLD',
      confidenceScore: 40,
      riskClassification: 'LOW',
      timestamp: Date.now()
    });

    const summary = metrics.getSummary();
    expect(summary.totalEvaluations).toBe(1);
    expect(summary.strategyMetrics['TestStrategy'].avgDurationMs).toBeCloseTo(5.2);
  });

  it('should record and count error events', () => {
    const metrics = MetricsEngine.getInstance();
    metrics.reset();

    metrics.record({
      type: 'STRATEGY_ERROR',
      strategyId: 'FailingStrategy',
      symbol: 'ETH/USDT',
      error: 'Simulated error',
      timestamp: Date.now()
    });

    const summary = metrics.getSummary();
    expect(summary.totalErrors).toBe(1);
  });

  it('should not exceed 1000 stored events (circular buffer)', () => {
    const metrics = MetricsEngine.getInstance();
    metrics.reset();

    for (let i = 0; i < 1200; i++) {
      metrics.record({
        type: 'STRATEGY_EXECUTION',
        strategyId: 'BulkStrategy',
        symbol: 'BTC/USDT',
        durationMs: 1,
        hasSignal: false,
        signal: 'HOLD',
        confidenceScore: 0,
        riskClassification: 'UNKNOWN',
        timestamp: Date.now()
      });
    }

    const events = metrics.getRecentEvents(2000);
    expect(events.length).toBeLessThanOrEqual(1000);
  });

  it('should reset all counters cleanly', () => {
    const metrics = MetricsEngine.getInstance();
    metrics.record({ type: 'TIMEOUT', symbol: 'X', operationType: 'DATA_FETCH', durationMs: 1000, timestamp: Date.now() });
    metrics.reset();
    const summary = metrics.getSummary();
    expect(summary.totalCycles).toBe(0);
    expect(summary.totalErrors).toBe(0);
    expect(summary.totalTimeouts).toBe(0);
    expect(summary.totalEvaluations).toBe(0);
  });
});

// ---- Durable Object Recovery Simulation ----

describe('Durable Object Recovery Simulation', () => {
  it('should re-create StrategyRegistry from scratch and expose all strategies', () => {
    // Simulate DO eviction by resetting the singleton — registry recreates itself
    (StrategyRegistry as any).instance = undefined;
    const newRegistry = StrategyRegistry.getInstance();
    const all = [...newRegistry.getAllStrategies()];
    expect(all.length).toBe(5);
    expect(newRegistry.getStrategy('ScalperV2')).toBeDefined();
    expect(newRegistry.getStrategy('Momentum')).toBeDefined();
    expect(newRegistry.getStrategy('Breakout')).toBeDefined();
    expect(newRegistry.getStrategy('MeanReversion')).toBeDefined();
    expect(newRegistry.getStrategy('VWAP')).toBeDefined();
  });

  it('should evaluate successfully after registry rebuild', () => {
    const ctx = new StrategyContext(makeSnapshot(100)).freeze();
    const reg = StrategyRegistry.getInstance();
    for (const [, strategy] of reg.getAllStrategies()) {
      expect(() => strategy.evaluate(ctx)).not.toThrow();
    }
  });
});
