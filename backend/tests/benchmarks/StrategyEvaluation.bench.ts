/**
 * StrategyEvaluation.bench.ts
 *
 * Performance benchmarks for the Strategy Evaluation Platform.
 * Run via: npx vitest bench
 *
 * Measures:
 *  - Individual strategy execution time
 *  - Combined 5-strategy evaluation
 *  - Symbol-scaled evaluation (10 / 25 / 50 / 100 symbols)
 */

import { bench, describe } from 'vitest';
import { StrategyContext } from '../../src/engine/context/StrategyContext';
import { StrategyRegistry } from '../../src/engine/strategies/StrategyRegistry';

// ---- Minimal valid market snapshot for benchmarking ----

function makeCandles(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: 1_700_000_000_000 + i * 60_000,
    open: 150 + Math.sin(i * 0.1) * 10,
    high: 155 + Math.sin(i * 0.1) * 10,
    low: 145 + Math.sin(i * 0.1) * 10,
    close: 150 + Math.cos(i * 0.1) * 10,
    volume: 1000 + i * 5
  }));
}

const candles100 = makeCandles(100);
const candles200 = makeCandles(200);

const snapshot = {
  symbol: 'BTC/USDT',
  timestamp: Date.now(),
  currentPrice: 150,
  volume24h: 100000,
  quoteVolume24h: 15000000,
  metadata: { priceChange24h: 2, priceChangePercent24h: 1.5, highPrice24h: 160, lowPrice24h: 140 },
  candles: {
    '5m': candles100,
    '15m': candles200,
    '1h': candles200
  } as any
};

const registry = StrategyRegistry.getInstance();
const scalper = registry.getStrategy('ScalperV2')!;
const momentum = registry.getStrategy('Momentum')!;
const breakout = registry.getStrategy('Breakout')!;
const meanReversion = registry.getStrategy('MeanReversion')!;
const vwap = registry.getStrategy('VWAP')!;

// ---- Individual Strategy Benchmarks ----

describe('Individual Strategy Evaluation', () => {
  bench('ScalperV2 - single evaluation', () => {
    const ctx = new StrategyContext(snapshot).freeze();
    scalper.evaluate(ctx);
  });

  bench('Momentum - single evaluation', () => {
    const ctx = new StrategyContext(snapshot).freeze();
    momentum.evaluate(ctx);
  });

  bench('Breakout - single evaluation', () => {
    const ctx = new StrategyContext(snapshot).freeze();
    breakout.evaluate(ctx);
  });

  bench('MeanReversion - single evaluation', () => {
    const ctx = new StrategyContext(snapshot).freeze();
    meanReversion.evaluate(ctx);
  });

  bench('VWAP - single evaluation', () => {
    const ctx = new StrategyContext(snapshot).freeze();
    vwap.evaluate(ctx);
  });
});

// ---- Combined 5-Strategy Evaluation Benchmark ----

describe('Combined Strategy Evaluation', () => {
  bench('All 5 strategies on a single snapshot', () => {
    const ctx = new StrategyContext(snapshot).freeze();
    scalper.evaluate(ctx);
    momentum.evaluate(ctx);
    breakout.evaluate(ctx);
    meanReversion.evaluate(ctx);
    vwap.evaluate(ctx);
  });
});

// ---- Symbol-Scale Benchmarks ----

function makeSymbolBatch(count: number): typeof snapshot[] {
  return Array.from({ length: count }, (_, i) => ({
    ...snapshot,
    symbol: `COIN${i}/USDT`,
    timestamp: Date.now() + i
  }));
}

describe('Symbol-Scale Evaluation', () => {
  bench('10 symbols × 5 strategies', () => {
    const batch = makeSymbolBatch(10);
    for (const s of batch) {
      const ctx = new StrategyContext(s).freeze();
      scalper.evaluate(ctx);
      momentum.evaluate(ctx);
      breakout.evaluate(ctx);
      meanReversion.evaluate(ctx);
      vwap.evaluate(ctx);
    }
  });

  bench('25 symbols × 5 strategies', () => {
    const batch = makeSymbolBatch(25);
    for (const s of batch) {
      const ctx = new StrategyContext(s).freeze();
      scalper.evaluate(ctx);
      momentum.evaluate(ctx);
      breakout.evaluate(ctx);
      meanReversion.evaluate(ctx);
      vwap.evaluate(ctx);
    }
  });

  bench('50 symbols × 5 strategies', () => {
    const batch = makeSymbolBatch(50);
    for (const s of batch) {
      const ctx = new StrategyContext(s).freeze();
      scalper.evaluate(ctx);
      momentum.evaluate(ctx);
      breakout.evaluate(ctx);
      meanReversion.evaluate(ctx);
      vwap.evaluate(ctx);
    }
  });

  bench('100 symbols × 5 strategies', () => {
    const batch = makeSymbolBatch(100);
    for (const s of batch) {
      const ctx = new StrategyContext(s).freeze();
      scalper.evaluate(ctx);
      momentum.evaluate(ctx);
      breakout.evaluate(ctx);
      meanReversion.evaluate(ctx);
      vwap.evaluate(ctx);
    }
  });
});
