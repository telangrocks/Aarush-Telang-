import { describe, it, expect } from 'vitest';
import { MarketRegimeEngine, MarketRegime } from './MarketRegimeEngine';

describe('MarketRegimeEngine', () => {
  it('should detect TRENDING regime when ADX is high and EMA slope is positive', () => {
    const closes: number[] = [];
    const highs: number[] = [];
    const lows: number[] = [];

    // Generate strong uptrend data
    let base = 100;
    for (let i = 0; i < 50; i++) {
      base += 2.0;
      closes.push(base);
      highs.push(base + 1.5);
      lows.push(base - 0.5);
    }

    const regime = MarketRegimeEngine.evaluate(highs, lows, closes, 1.0);
    expect(regime.regime).toBe('TRENDING');
    expect(regime.allowTrendStrategies).toBe(true);
    expect(regime.allowMeanReversion).toBe(false);
  });

  it('should detect RANGING regime when price oscillates in a narrow band', () => {
    const closes: number[] = [];
    const highs: number[] = [];
    const lows: number[] = [];

    // Generate sideways data
    for (let i = 0; i < 50; i++) {
      const price = 100 + (i % 2 === 0 ? 0.5 : -0.5);
      closes.push(price);
      highs.push(price + 0.5);
      lows.push(price - 0.5);
    }

    const regime = MarketRegimeEngine.evaluate(highs, lows, closes, 0.5);
    expect(regime.regime).toBe('RANGING');
    expect(regime.allowMeanReversion).toBe(true);
    expect(regime.allowTrendStrategies).toBe(false);
  });

  it('should detect VOLATILE regime when ATR expansion ratio is high', () => {
    const closes: number[] = [];
    const highs: number[] = [];
    const lows: number[] = [];

    for (let i = 0; i < 50; i++) {
      closes.push(100);
      highs.push(101);
      lows.push(99);
    }

    // High current ATR expansion (3.0 vs long-term average 1.0)
    const regime = MarketRegimeEngine.evaluate(highs, lows, closes, 3.0);
    expect(regime.regime).toBe('VOLATILE');
  });

  it('should correctly enforce strategy permissions based on regime', () => {
    const trendingRegime: MarketRegime = {
      regime: 'TRENDING',
      score: 85,
      allowTrendStrategies: true,
      allowMeanReversion: false
    };

    const rangingRegime: MarketRegime = {
      regime: 'RANGING',
      score: 75,
      allowTrendStrategies: false,
      allowMeanReversion: true
    };

    expect(MarketRegimeEngine.isStrategyAllowed('momentum', trendingRegime).allowed).toBe(true);
    expect(MarketRegimeEngine.isStrategyAllowed('Momentum', trendingRegime).allowed).toBe(true);
    expect(MarketRegimeEngine.isStrategyAllowed('breakout', trendingRegime).allowed).toBe(true);
    expect(MarketRegimeEngine.isStrategyAllowed('Breakout', trendingRegime).allowed).toBe(true);
    expect(MarketRegimeEngine.isStrategyAllowed('mean_reversion', trendingRegime).allowed).toBe(false);
    expect(MarketRegimeEngine.isStrategyAllowed('MeanReversion', trendingRegime).allowed).toBe(false);

    expect(MarketRegimeEngine.isStrategyAllowed('mean_reversion', rangingRegime).allowed).toBe(true);
    expect(MarketRegimeEngine.isStrategyAllowed('MeanReversion', rangingRegime).allowed).toBe(true);
    expect(MarketRegimeEngine.isStrategyAllowed('momentum', rangingRegime).allowed).toBe(false);
    expect(MarketRegimeEngine.isStrategyAllowed('Momentum', rangingRegime).allowed).toBe(false);

    // ScalperV2 score check (>60)
    expect(MarketRegimeEngine.isStrategyAllowed('ScalperV2', { regime: 'RANGING', score: 65, allowTrendStrategies: false, allowMeanReversion: true }).allowed).toBe(true);
    expect(MarketRegimeEngine.isStrategyAllowed('ScalperV2', { regime: 'RANGING', score: 45, allowTrendStrategies: false, allowMeanReversion: true }).allowed).toBe(false);

    // VWAP volatility check
    expect(MarketRegimeEngine.isStrategyAllowed('VWAP', { regime: 'VOLATILE', score: 50, allowTrendStrategies: true, allowMeanReversion: false }).allowed).toBe(false);
    expect(MarketRegimeEngine.isStrategyAllowed('VWAP', { regime: 'VOLATILE', score: 75, allowTrendStrategies: true, allowMeanReversion: false }).allowed).toBe(true);
  });
});
