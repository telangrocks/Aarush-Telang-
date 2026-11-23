import { describe, it, expect } from 'vitest';
import { SignalEngine } from './SignalEngine';
import { SignalType } from './SignalType';
import { SignalContext } from './TradingSignal';
import { SignalRules } from './SignalValidator';
import { ConditionResult } from '../condition';
import { ConfidenceScore } from '../confidence';
import { RiskAssessment } from '../risk';
import { ScalperV2Strategy } from '../strategies/scalper-v2/ScalperV2Strategy';
import { StrategyContext } from '../context/StrategyContext';
import { MarketSnapshot } from '../market-data/MarketSnapshot';

describe('SignalEngine', () => {
  const rules: SignalRules = {
    minConfidenceScore: 70,
    allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH']
  };

  const context: SignalContext = {
    symbol: 'BTC/USDT',
    timeframe: '15m',
    currentPrice: 50000
  };

  const conditionResultBase = {
    timestamp: 123,
    timeframes: {
      '15m': {
        trend: { trendDirection: 'UP', emaCrossoverState: 'BULLISH', priceAboveEMA: true },
        momentum: { rsiState: 'NEUTRAL', macdDirection: 'BULLISH' },
        volatility: { atrState: 'EXPANDING' },
        volume: { volumeTrend: 'INCREASING', volumeConfirmation: true }
      }
    }
  } as ConditionResult;

  it('should generate a BUY signal when conditions, confidence, and risk are valid', () => {
    const engine = new SignalEngine(rules);

    const confidenceScore: ConfidenceScore = {
      timestamp: 123,
      overallScore: 85,
      overallLevel: 'HIGH',
      timeframes: {
        '15m': {
          score: 85,
          longScore: 85,
          shortScore: 0,
          level: 'HIGH',
          factors: { trendScore: 100, momentumScore: 100, volatilityScore: 100, volumeScore: 100 },
          explanation: []
        }
      }
    };

    const riskAssessment: RiskAssessment = {
      timestamp: 123,
      stopLossDistance: 500,
      takeProfitDistance: 1000,
      riskRewardRatio: 2.0,
      positionSizeRecommendation: 1000,
      maximumExposure: 5000,
      riskClassification: 'MEDIUM',
      explanation: []
    };

    const signal = engine.evaluate(context, conditionResultBase, confidenceScore, riskAssessment);

    expect(signal).not.toBeNull();
    expect(signal!.type).toBe(SignalType.BUY);
    expect(signal!.signalPrice).toBe(50000);
    expect(signal!.entryPrice).toBe(50000);
    expect(signal!.stopLoss).toBe(49500); // 50000 - 500
    expect(signal!.takeProfit).toBe(51000); // 50000 + 1000
    expect(signal!.confidenceScore).toBe(85);
  });

  it('should return null (no signal) when confidence is too low', () => {
    const engine = new SignalEngine(rules);

    const confidenceScore: ConfidenceScore = {
      timestamp: 123,
      overallScore: 60,
      overallLevel: 'MEDIUM',
      timeframes: {
        '15m': {
          score: 60, // Below min 70
          longScore: 60,
          shortScore: 0,
          level: 'MEDIUM',
          factors: { trendScore: 50, momentumScore: 50, volatilityScore: 50, volumeScore: 50 },
          explanation: []
        }
      }
    };

    const riskAssessment: RiskAssessment = {
      timestamp: 123,
      stopLossDistance: 500,
      takeProfitDistance: 1000,
      riskRewardRatio: 2.0,
      positionSizeRecommendation: 1000,
      maximumExposure: 5000,
      riskClassification: 'MEDIUM',
      explanation: []
    };

    const signal = engine.evaluate(context, conditionResultBase, confidenceScore, riskAssessment);

    expect(signal).toBeNull();
  });

  it('should return null (no signal) when risk is unacceptable', () => {
    const engine = new SignalEngine(rules);

    const confidenceScore: ConfidenceScore = {
      timestamp: 123,
      overallScore: 90,
      overallLevel: 'HIGH',
      timeframes: {
        '15m': {
          score: 90,
          longScore: 90,
          shortScore: 0,
          level: 'HIGH',
          factors: { trendScore: 100, momentumScore: 100, volatilityScore: 100, volumeScore: 100 },
          explanation: []
        }
      }
    };

    const riskAssessment: RiskAssessment = {
      timestamp: 123,
      stopLossDistance: 5000,
      takeProfitDistance: 10000,
      riskRewardRatio: 2.0,
      positionSizeRecommendation: 10000,
      maximumExposure: 10000,
      riskClassification: 'EXTREME', // Not in allowed ['LOW', 'MEDIUM', 'HIGH']
      explanation: []
    };

    const signal = engine.evaluate(context, conditionResultBase, confidenceScore, riskAssessment);

    expect(signal).toBeNull();
  });

  it('should fail closed and return null when risk assessment is missing or null', () => {
    const engine = new SignalEngine(rules);

    const confidenceScore: ConfidenceScore = {
      timestamp: 123,
      overallScore: 90,
      overallLevel: 'HIGH',
      timeframes: {
        '15m': {
          score: 90,
          longScore: 90,
          shortScore: 0,
          level: 'HIGH',
          factors: { trendScore: 100, momentumScore: 100, volatilityScore: 100, volumeScore: 100 },
          explanation: []
        }
      }
    };

    const signalNullRisk = engine.evaluate(context, conditionResultBase, confidenceScore, null as any);
    expect(signalNullRisk).toBeNull();

    const signalUndefinedRisk = engine.evaluate(context, conditionResultBase, confidenceScore, undefined as any);
    expect(signalUndefinedRisk).toBeNull();
  });

  it('should fail closed and return null when risk classification is missing or invalid', () => {
    const engine = new SignalEngine(rules);

    const confidenceScore: ConfidenceScore = {
      timestamp: 123,
      overallScore: 90,
      overallLevel: 'HIGH',
      timeframes: {
        '15m': {
          score: 90,
          longScore: 90,
          shortScore: 0,
          level: 'HIGH',
          factors: { trendScore: 100, momentumScore: 100, volatilityScore: 100, volumeScore: 100 },
          explanation: []
        }
      }
    };

    const riskAssessmentMissingClass = {
      timestamp: 123,
      stopLossDistance: 500,
      takeProfitDistance: 1000,
      riskRewardRatio: 2.0,
      positionSizeRecommendation: 1000,
      maximumExposure: 5000,
      explanation: []
    } as any;

    const signal = engine.evaluate(context, conditionResultBase, confidenceScore, riskAssessmentMissingClass);
    expect(signal).toBeNull();
  });

  describe('Model C Directional Arbitration & Reversals', () => {
    const riskAssessment: RiskAssessment = {
      timestamp: 123,
      stopLossDistance: 500,
      takeProfitDistance: 1000,
      riskRewardRatio: 2.0,
      positionSizeRecommendation: 1000,
      maximumExposure: 5000,
      riskClassification: 'MEDIUM',
      explanation: []
    };

    it('generates a SELL signal during a bullish macro trend when shortScore qualifies and longScore does not (bullish-trend SHORT reversal)', () => {
      const engine = new SignalEngine(rules);
      const bullishTrendCondition = {
        timestamp: 123,
        timeframes: {
          '15m': {
            trend: { trendDirection: 'UP', emaCrossoverState: 'BULLISH', priceAboveEMA: true },
            momentum: { rsiState: 'OVERBOUGHT', macdDirection: 'BEARISH' },
            volatility: { atrState: 'EXPANDING' },
            volume: { volumeTrend: 'INCREASING', volumeConfirmation: true }
          }
        }
      } as unknown as ConditionResult;

      const confidenceScore: ConfidenceScore = {
        timestamp: 123,
        overallScore: 85,
        overallLevel: 'HIGH',
        timeframes: {
          '15m': {
            score: 85,
            longScore: 20, // does not qualify (< 70)
            shortScore: 85, // qualifies (>= 70)
            level: 'HIGH',
            factors: { trendScore: 20, momentumScore: 90, volatilityScore: 80, volumeScore: 80 },
            explanation: []
          }
        }
      };

      const signal = engine.evaluate(context, bullishTrendCondition, confidenceScore, riskAssessment);
      expect(signal).not.toBeNull();
      expect(signal!.type).toBe(SignalType.SELL);
      expect(signal!.confidenceScore).toBe(85);
      expect(signal!.stopLoss).toBe(50500); // 50000 + 500
      expect(signal!.takeProfit).toBe(49000); // 50000 - 1000
    });

    it('generates a BUY signal during a bearish macro trend when longScore qualifies and shortScore does not (bearish-trend BUY reversal)', () => {
      const engine = new SignalEngine(rules);
      const bearishTrendCondition = {
        timestamp: 123,
        timeframes: {
          '15m': {
            trend: { trendDirection: 'DOWN', emaCrossoverState: 'BEARISH', priceAboveEMA: false },
            momentum: { rsiState: 'OVERSOLD', macdDirection: 'BULLISH' },
            volatility: { atrState: 'EXPANDING' },
            volume: { volumeTrend: 'INCREASING', volumeConfirmation: true }
          }
        }
      } as unknown as ConditionResult;

      const confidenceScore: ConfidenceScore = {
        timestamp: 123,
        overallScore: 85,
        overallLevel: 'HIGH',
        timeframes: {
          '15m': {
            score: 85,
            longScore: 85, // qualifies (>= 70)
            shortScore: 20, // does not qualify (< 70)
            level: 'HIGH',
            factors: { trendScore: 80, momentumScore: 90, volatilityScore: 80, volumeScore: 80 },
            explanation: []
          }
        }
      };

      const signal = engine.evaluate(context, bearishTrendCondition, confidenceScore, riskAssessment);
      expect(signal).not.toBeNull();
      expect(signal!.type).toBe(SignalType.BUY);
      expect(signal!.confidenceScore).toBe(85);
      expect(signal!.stopLoss).toBe(49500); // 50000 - 500
      expect(signal!.takeProfit).toBe(51000); // 50000 + 1000
    });

    it('returns null when both longScore and shortScore qualify simultaneously (conflict / whipsaw arbitration)', () => {
      const engine = new SignalEngine(rules);
      const confidenceScore: ConfidenceScore = {
        timestamp: 123,
        overallScore: 85,
        overallLevel: 'HIGH',
        timeframes: {
          '15m': {
            score: 85,
            longScore: 85, // >= 70
            shortScore: 80, // >= 70 (conflict!)
            level: 'HIGH',
            factors: { trendScore: 50, momentumScore: 50, volatilityScore: 50, volumeScore: 50 },
            explanation: []
          }
        }
      };

      const signal = engine.evaluate(context, conditionResultBase, confidenceScore, riskAssessment);
      expect(signal).toBeNull();
    });

    it('returns null when neither longScore nor shortScore qualifies (below minConfidenceScore)', () => {
      const engine = new SignalEngine(rules);
      const confidenceScore: ConfidenceScore = {
        timestamp: 123,
        overallScore: 55,
        overallLevel: 'LOW',
        timeframes: {
          '15m': {
            score: 55,
            longScore: 55, // < 70
            shortScore: 40, // < 70
            level: 'LOW',
            factors: { trendScore: 50, momentumScore: 50, volatilityScore: 50, volumeScore: 50 },
            explanation: []
          }
        }
      };

      const signal = engine.evaluate(context, conditionResultBase, confidenceScore, riskAssessment);
      expect(signal).toBeNull();
    });

    it('returns null when directional scores are missing or non-numeric', () => {
      const engine = new SignalEngine(rules);
      const confidenceScore: ConfidenceScore = {
        timestamp: 123,
        overallScore: 85,
        overallLevel: 'HIGH',
        timeframes: {
          '15m': {
            score: 85,
            longScore: undefined as any,
            shortScore: undefined as any,
            level: 'HIGH',
            factors: { trendScore: 50, momentumScore: 50, volatilityScore: 50, volumeScore: 50 },
            explanation: []
          }
        }
      };

      const signal = engine.evaluate(context, conditionResultBase, confidenceScore, riskAssessment);
      expect(signal).toBeNull();
    });
  });

  describe('Zero-Hold Invariants', () => {
    it('Invariant 1: SignalType enum must only define BUY and SELL, never HOLD', () => {
      const enumKeys = Object.keys(SignalType);
      const enumValues = Object.values(SignalType);

      expect(enumKeys).toEqual(['BUY', 'SELL']);
      expect(enumValues).toEqual(['BUY', 'SELL']);
      expect((SignalType as any).HOLD).toBeUndefined();
    });

    it('Invariant 3: Unqualified setup due to neutral conditions returns null even with high confidence', () => {
      const engine = new SignalEngine(rules);
      const neutralConditions: ConditionResult = {
        timestamp: 1000,
        timeframes: {
          '15m': {
            trend: { trendDirection: 'SIDEWAYS', emaCrossoverState: 'NONE', priceAboveEMA: false },
            momentum: { rsiState: 'NEUTRAL', macdDirection: 'NEUTRAL' },
            volatility: { atrState: 'NEUTRAL' },
            volume: { volumeTrend: 'NEUTRAL', volumeConfirmation: false }
          }
        }
      };
      const highConfidence: ConfidenceScore = {
        timestamp: 1000,
        overallScore: 85,
        overallLongScore: 85,
        overallShortScore: 0,
        overallLevel: 'HIGH',
        timeframes: {
          '15m': {
            score: 85,
            longScore: 85,
            shortScore: 0,
            level: 'HIGH',
            factors: { trendScore: 100, momentumScore: 100, volatilityScore: 100, volumeScore: 100 },
            explanation: ['All factors strong']
          }
        }
      };
      const acceptableRisk: RiskAssessment = {
        timestamp: 1000,
        stopLossDistance: 500,
        takeProfitDistance: 1000,
        riskRewardRatio: 2.0,
        positionSizeRecommendation: 1000,
        maximumExposure: 5000,
        riskClassification: 'MEDIUM',
        explanation: ['Valid risk profile']
      };

      const signal = engine.evaluate(context, neutralConditions, highConfidence, acceptableRisk);
      expect(signal).toBeNull();
    });

    it('Invariant 6: Long-only strategy suppresses SELL to null (never converts to BUY or HOLD)', () => {
      const strategy = new ScalperV2Strategy();
      const bearishSnapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 80,
        volume24h: 10000,
        quoteVolume24h: 800000,
        metadata: { priceChange24h: -10, priceChangePercent24h: -10, highPrice24h: 100, lowPrice24h: 75 },
        candles: {
          '5m': [
            { timestamp: 1, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            { timestamp: 2, open: 100, high: 100, low: 85, close: 90, volume: 1200 },
            { timestamp: 3, open: 90, high: 90, low: 75, close: 80, volume: 2000 }
          ]
        } as any
      };

      const ctx = new StrategyContext(bearishSnapshot).freeze();
      const result = strategy.evaluate(ctx, '5m');

      expect(result.metadata.signal?.type).not.toBe('BUY');
      if (result.metadata.reasoning.some((r: string) => r.includes('Short signal suppressed'))) {
        expect(result.hasSignal).toBe(false);
        expect(result.metadata.signal).toBeNull();
      }
    });
  });
});
