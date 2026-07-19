import { describe, it, expect } from 'vitest';
import { SignalEngine } from './SignalEngine';
import { SignalType } from './SignalType';
import { SignalContext } from './TradingSignal';
import { SignalRules } from './SignalValidator';
import { ConditionResult } from '../condition';
import { ConfidenceScore } from '../confidence';
import { RiskAssessment } from '../risk';

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

    expect(signal.type).toBe(SignalType.BUY);
    expect(signal.entryPrice).toBe(50000);
    expect(signal.stopLoss).toBe(49500); // 50000 - 500
    expect(signal.takeProfit).toBe(51000); // 50000 + 1000
    expect(signal.confidenceScore).toBe(85);
  });

  it('should generate a HOLD signal when confidence is too low', () => {
    const engine = new SignalEngine(rules);

    const confidenceScore: ConfidenceScore = {
      timestamp: 123,
      overallScore: 60,
      overallLevel: 'MEDIUM',
      timeframes: {
        '15m': {
          score: 60, // Below min 70
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

    expect(signal.type).toBe(SignalType.HOLD);
    expect(signal.reasoning.some(r => r.includes('Confidence score (60) is below required minimum'))).toBe(true);
  });

  it('should generate a HOLD signal when risk is unacceptable', () => {
    const engine = new SignalEngine(rules);

    const confidenceScore: ConfidenceScore = {
      timestamp: 123,
      overallScore: 90,
      overallLevel: 'HIGH',
      timeframes: {
        '15m': {
          score: 90,
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

    expect(signal.type).toBe(SignalType.HOLD);
    expect(signal.reasoning.some(r => r.includes('Risk classification EXTREME is not allowed'))).toBe(true);
  });
});
