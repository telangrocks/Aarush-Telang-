import { describe, it, expect } from 'vitest';
import { StrategyCompatibilityEvaluator } from './StrategyCompatibilityEvaluator';
import { MarketRegime } from '../regime/MarketRegimeEngine';

describe('StrategyCompatibilityEvaluator', () => {
  const evaluator = new StrategyCompatibilityEvaluator();

  it('correctly maps directional constraints for ScalperV2 (supports LONG_AND_SHORT)', () => {
    const trendingRegime: MarketRegime = {
      regime: 'TRENDING',
      score: 85,
      allowTrendStrategies: true,
      allowMeanReversion: false,
    };

    const longVectors = evaluator.evaluate(trendingRegime, 'LONG');
    const shortVectors = evaluator.evaluate(trendingRegime, 'SHORT');

    const scalperLong = longVectors.find(v => v.strategyId === 'ScalperV2');
    const scalperShort = shortVectors.find(v => v.strategyId === 'ScalperV2');

    expect(scalperLong).toBeDefined();
    expect(scalperLong?.directionalSupport).toBe('LONG_AND_SHORT');
    expect(scalperLong?.isAllowedInRegime).toBe(true);

    expect(scalperShort).toBeDefined();
    expect(scalperShort?.directionalSupport).toBe('LONG_AND_SHORT');
    expect(scalperShort?.isAllowedInRegime).toBe(true);
  });

  it('correctly enforces directional constraints for Momentum (supports LONG_AND_SHORT based on manifest)', () => {
    const trendingRegime: MarketRegime = {
      regime: 'TRENDING',
      score: 85,
      allowTrendStrategies: true,
      allowMeanReversion: false,
    };

    const longVectors = evaluator.evaluate(trendingRegime, 'LONG');
    const shortVectors = evaluator.evaluate(trendingRegime, 'SHORT');

    const momentumLong = longVectors.find(v => v.strategyId === 'Momentum');
    const momentumShort = shortVectors.find(v => v.strategyId === 'Momentum');

    expect(momentumLong?.isAllowedInRegime).toBe(true);
    expect(momentumLong?.directionalSupport).toBe('LONG_AND_SHORT');

    expect(momentumShort?.isAllowedInRegime).toBe(true);
    expect(momentumShort?.directionalSupport).toBe('LONG_AND_SHORT');
  });

  it('allows VWAP for both LONG and SHORT during suitable regime', () => {
    const trendingRegime: MarketRegime = {
      regime: 'TRENDING',
      score: 85,
      allowTrendStrategies: true,
      allowMeanReversion: false,
    };

    const longVectors = evaluator.evaluate(trendingRegime, 'LONG');
    const shortVectors = evaluator.evaluate(trendingRegime, 'SHORT');

    const vwapLong = longVectors.find(v => v.strategyId === 'VWAP');
    const vwapShort = shortVectors.find(v => v.strategyId === 'VWAP');

    expect(vwapLong?.isAllowedInRegime).toBe(true);
    expect(vwapLong?.directionalSupport).toBe('LONG_AND_SHORT');

    expect(vwapShort?.isAllowedInRegime).toBe(true);
    expect(vwapShort?.directionalSupport).toBe('LONG_AND_SHORT');
  });

  it('allows MeanReversion (LONG_AND_SHORT) only in RANGING regime', () => {
    const trendingRegime: MarketRegime = {
      regime: 'TRENDING',
      score: 85,
      allowTrendStrategies: true,
      allowMeanReversion: false,
    };

    const rangingRegime: MarketRegime = {
      regime: 'RANGING',
      score: 75,
      allowTrendStrategies: false,
      allowMeanReversion: true,
    };

    const trendingVectors = evaluator.evaluate(trendingRegime, 'LONG');
    const rangingVectors = evaluator.evaluate(rangingRegime, 'LONG');

    const mrTrending = trendingVectors.find(v => v.strategyId === 'MeanReversion');
    const mrRanging = rangingVectors.find(v => v.strategyId === 'MeanReversion');

    expect(mrTrending?.isAllowedInRegime).toBe(false);
    expect(mrRanging?.isAllowedInRegime).toBe(true);
    expect(mrRanging?.directionalSupport).toBe('LONG_AND_SHORT');
    expect(mrRanging?.compatibilityScore).toBeGreaterThanOrEqual(75);
  });

  it('enforces that StrategyCompatibility != StrategySignal: produces compatibility vectors without generating TradingSignals', () => {
    const regime: MarketRegime = {
      regime: 'TRENDING',
      score: 90,
      allowTrendStrategies: true,
      allowMeanReversion: false,
    };

    const vectors = evaluator.evaluate(regime, 'LONG');
    
    for (const v of vectors) {
      expect((v as any).signal).toBeUndefined();
      expect((v as any).signalType).toBeUndefined();
      expect((v as any).entryPrice).toBeUndefined();
      expect(typeof v.compatibilityScore).toBe('number');
    }
  });
});
