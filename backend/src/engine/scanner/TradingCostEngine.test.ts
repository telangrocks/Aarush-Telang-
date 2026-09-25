import { describe, it, expect } from 'vitest';
import { TradingCostEngine, TradingCostInput } from './TradingCostEngine';
import { DEFAULT_SCANNER_CONFIG } from './ScannerTypes';

describe('TradingCostEngine', () => {
  const engine = new TradingCostEngine(DEFAULT_SCANNER_CONFIG);

  it('calculates spread percentage accurately from bid and ask', () => {
    const input: TradingCostInput = {
      price: 100,
      bid: 99.98,
      ask: 100.02,
      expectedTargetPercent: 2.0,
    };

    const result = engine.evaluate(input);
    expect(result.midPrice).toBe(100);
    expect(result.spreadPercent).toBeCloseTo(0.04, 3);
  });

  it('incorporates two-way taker fees into total friction', () => {
    const input: TradingCostInput = {
      price: 50000,
      bid: 49995,
      ask: 50005,
      expectedTargetPercent: 1.5,
    };

    const result = engine.evaluate(input);
    expect(result.roundTripFeePercent).toBe(0.11);
    expect(result.totalFrictionPercent).toBeGreaterThan(0.11);
  });

  it('dynamically estimates slippage from ATR, spread, and order size', () => {
    const liquidMarket: TradingCostInput = {
      price: 100,
      bid: 99.99,
      ask: 100.01,
      atr1m: 0.10,
      expectedTargetPercent: 2.0,
      turnover1mUsdt: 500_000,
      hypotheticalOrderSizeUsdt: 1_000,
    };

    const thinMarket: TradingCostInput = {
      price: 100,
      bid: 99.90,
      ask: 100.10,
      atr1m: 1.50,
      expectedTargetPercent: 2.0,
      turnover1mUsdt: 5_000,
      hypotheticalOrderSizeUsdt: 2_500,
    };

    const liquidResult = engine.evaluate(liquidMarket);
    const thinResult = engine.evaluate(thinMarket);

    expect(thinResult.estimatedSlippagePercent).toBeGreaterThan(liquidResult.estimatedSlippagePercent);
    expect(thinResult.totalFrictionPercent).toBeGreaterThan(liquidResult.totalFrictionPercent);
  });

  it('determines viability based on net edge ratio', () => {
    const highEdgeInput: TradingCostInput = {
      price: 100,
      bid: 99.99,
      ask: 100.01,
      atr1m: 0.05,
      expectedTargetPercent: 2.5,
    };

    const lowEdgeInput: TradingCostInput = {
      price: 100,
      bid: 99.80,
      ask: 100.20,
      atr1m: 1.0,
      expectedTargetPercent: 0.3,
    };

    const highEdge = engine.evaluate(highEdgeInput);
    const lowEdge = engine.evaluate(lowEdgeInput);

    expect(highEdge.isViable).toBe(true);
    expect(highEdge.netEdgeRatio).toBeGreaterThan(5.0);
    expect(highEdge.feasibilityScore).toBe(100);

    expect(lowEdge.isViable).toBe(false);
    expect(lowEdge.netEdgeRatio).toBeLessThan(DEFAULT_SCANNER_CONFIG.minNetEdgeRatio);
    expect(lowEdge.warnings.length).toBeGreaterThan(0);
  });

  it('penalizes wide spreads exceeding maxSpreadPercent', () => {
    const wideSpreadInput: TradingCostInput = {
      price: 100,
      bid: 99.70,
      ask: 100.30,
      expectedTargetPercent: 3.0,
    };

    const result = engine.evaluate(wideSpreadInput);
    expect(result.isViable).toBe(false);
    expect(result.warnings.some(w => w.includes('Excessive spread'))).toBe(true);
  });
});
