import { describe, it, expect } from 'vitest';
import { SignalValidator, SignalRules } from './SignalValidator';
import { SignalType } from './SignalType';
import { SignalEngine } from './SignalEngine';
import { TimeframeConfidence, ConfidenceEngine } from '../confidence';
import { RiskAssessment } from '../risk';
import { ConditionResult } from '../condition';
import { StrategyContext } from '../context/StrategyContext';
import { MarketSnapshot } from '../market-data/MarketSnapshot';
import { ScalperV2Strategy } from '../strategies/scalper-v2/ScalperV2Strategy';
import { MomentumStrategy } from '../strategies/momentum/MomentumStrategy';
import { BreakoutStrategy } from '../strategies/breakout/BreakoutStrategy';
import { MeanReversionStrategy } from '../strategies/mean-reversion/MeanReversionStrategy';
import { VWAPStrategy } from '../strategies/vwap/VWAPStrategy';

describe('Model C Long + Short Confidence Architecture', () => {
  const rules: SignalRules = {
    minConfidenceScore: 70,
    allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH']
  };

  const dummyFactors = { trendScore: 50, momentumScore: 50, volatilityScore: 50, volumeScore: 50 };

  const validRisk: RiskAssessment = {
    timestamp: 1000,
    stopLossDistance: 100,
    takeProfitDistance: 200,
    riskRewardRatio: 2.0,
    positionSizeRecommendation: 1000,
    maximumExposure: 5000,
    riskClassification: 'LOW',
    explanation: ['Valid risk']
  };

  // ----------------------------------------------------------------------
  // 1. Strict Fail-Closed Model C Arbitration & 10-Case Test Matrix
  // ----------------------------------------------------------------------
  describe('Model C Arbitration Matrix & Strict Fail-Closed Behavior', () => {
    const validator = new SignalValidator(rules);

    it('Case 1: longScore=undefined, shortScore=undefined, proposed=BUY -> FAIL CLOSED', () => {
      const tfConf: TimeframeConfidence = {
        score: 85,
        level: 'HIGH',
        factors: dummyFactors,
        explanation: []
      };
      const res = validator.validate(tfConf, validRisk, SignalType.BUY);
      expect(res.isValid).toBe(false);
      expect(res.reasoning[0]).toContain('[FAIL-CLOSED]');
    });

    it('Case 2: longScore=undefined, shortScore=undefined, proposed=SELL -> FAIL CLOSED', () => {
      const tfConf: TimeframeConfidence = {
        score: 85,
        level: 'HIGH',
        factors: dummyFactors,
        explanation: []
      };
      const res = validator.validate(tfConf, validRisk, SignalType.SELL);
      expect(res.isValid).toBe(false);
      expect(res.reasoning[0]).toContain('[FAIL-CLOSED]');
    });

    it('Case 3: longScore=75, shortScore=undefined, proposed=BUY -> FAIL CLOSED', () => {
      const tfConf: TimeframeConfidence = {
        score: 75,
        longScore: 75,
        shortScore: undefined,
        level: 'HIGH',
        factors: dummyFactors,
        explanation: []
      };
      const res = validator.validate(tfConf, validRisk, SignalType.BUY);
      expect(res.isValid).toBe(false);
      expect(res.reasoning[0]).toContain('[FAIL-CLOSED]');
    });

    it('Case 4: longScore=undefined, shortScore=75, proposed=SELL -> FAIL CLOSED', () => {
      const tfConf: TimeframeConfidence = {
        score: 75,
        longScore: undefined,
        shortScore: 75,
        level: 'HIGH',
        factors: dummyFactors,
        explanation: []
      };
      const res = validator.validate(tfConf, validRisk, SignalType.SELL);
      expect(res.isValid).toBe(false);
      expect(res.reasoning[0]).toContain('[FAIL-CLOSED]');
    });

    it('Case 5: longScore=75, shortScore=undefined, proposed=SELL -> FAIL CLOSED', () => {
      const tfConf: TimeframeConfidence = {
        score: 75,
        longScore: 75,
        shortScore: undefined,
        level: 'HIGH',
        factors: dummyFactors,
        explanation: []
      };
      const res = validator.validate(tfConf, validRisk, SignalType.SELL);
      expect(res.isValid).toBe(false);
      expect(res.reasoning[0]).toContain('[FAIL-CLOSED]');
    });

    it('Case 6: longScore=undefined, shortScore=75, proposed=BUY -> FAIL CLOSED', () => {
      const tfConf: TimeframeConfidence = {
        score: 75,
        longScore: undefined,
        shortScore: 75,
        level: 'HIGH',
        factors: dummyFactors,
        explanation: []
      };
      const res = validator.validate(tfConf, validRisk, SignalType.BUY);
      expect(res.isValid).toBe(false);
      expect(res.reasoning[0]).toContain('[FAIL-CLOSED]');
    });

    it('Case 7: longScore=75, shortScore=60, proposed=BUY -> PASS', () => {
      const tfConf: TimeframeConfidence = {
        score: 75,
        longScore: 75,
        shortScore: 60,
        level: 'HIGH',
        factors: dummyFactors,
        explanation: []
      };
      const res = validator.validate(tfConf, validRisk, SignalType.BUY);
      expect(res.isValid).toBe(true);
      expect(res.reasoning[0]).toContain('Model C BUY qualified');
    });

    it('Case 8: longScore=60, shortScore=75, proposed=SELL -> PASS', () => {
      const tfConf: TimeframeConfidence = {
        score: 60,
        longScore: 60,
        shortScore: 75,
        level: 'HIGH',
        factors: dummyFactors,
        explanation: []
      };
      const res = validator.validate(tfConf, validRisk, SignalType.SELL);
      expect(res.isValid).toBe(true);
      expect(res.reasoning[0]).toContain('Model C SELL qualified');
    });

    it('Case 9: longScore=75, shortScore=75, proposed=BUY or SELL -> REJECT (both >= threshold)', () => {
      const tfConf: TimeframeConfidence = {
        score: 75,
        longScore: 75,
        shortScore: 75,
        level: 'HIGH',
        factors: dummyFactors,
        explanation: []
      };
      const resBuy = validator.validate(tfConf, validRisk, SignalType.BUY);
      expect(resBuy.isValid).toBe(false);
      expect(resBuy.reasoning[0]).toContain('Model C BUY rejected');

      const resSell = validator.validate(tfConf, validRisk, SignalType.SELL);
      expect(resSell.isValid).toBe(false);
      expect(resSell.reasoning[0]).toContain('Model C SELL rejected');
    });

    it('Case 10: longScore=60, shortScore=60, proposed=BUY or SELL -> REJECT (both < threshold)', () => {
      const tfConf: TimeframeConfidence = {
        score: 60,
        longScore: 60,
        shortScore: 60,
        level: 'MEDIUM',
        factors: dummyFactors,
        explanation: []
      };
      const resBuy = validator.validate(tfConf, validRisk, SignalType.BUY);
      expect(resBuy.isValid).toBe(false);
      expect(resBuy.reasoning[0]).toContain('Model C BUY rejected');

      const resSell = validator.validate(tfConf, validRisk, SignalType.SELL);
      expect(resSell.isValid).toBe(false);
      expect(resSell.reasoning[0]).toContain('Model C SELL rejected');
    });
  });

  // ----------------------------------------------------------------------
  // 2. Isolated Legacy Path Compatibility
  // ----------------------------------------------------------------------
  describe('Isolated Legacy Path (No proposedType)', () => {
    const validator = new SignalValidator(rules);

    it('passes legacy score >= threshold when proposedType is omitted', () => {
      const tfConf: TimeframeConfidence = {
        score: 70,
        level: 'HIGH',
        factors: dummyFactors,
        explanation: []
      };
      const res = validator.validate(tfConf, validRisk);
      expect(res.isValid).toBe(true);
      expect(res.reasoning[0]).toContain('passes threshold');
    });

    it('rejects legacy score < threshold when proposedType is omitted', () => {
      const tfConf: TimeframeConfidence = {
        score: 69,
        level: 'MEDIUM',
        factors: dummyFactors,
        explanation: []
      };
      const res = validator.validate(tfConf, validRisk);
      expect(res.isValid).toBe(false);
      expect(res.reasoning[0]).toContain('below required minimum');
    });
  });

  // ----------------------------------------------------------------------
  // 3. Multi-Timeframe Confidence Aggregation
  // ----------------------------------------------------------------------
  describe('Multi-Timeframe Aggregation', () => {
    const confidenceEngine = new ConfidenceEngine();

    it('computes overallLongScore and overallShortScore across multiple timeframes', () => {
      const result = confidenceEngine.evaluate({
        timestamp: Date.now(),
        timeframes: {
          '5m': {
            trend: { priceAboveEMA: false, emaCrossoverState: 'BEARISH', trendDirection: 'DOWN' },
            momentum: { rsiState: 'OVERSOLD', macdDirection: 'BEARISH' },
            volatility: { atrState: 'EXPANDING' },
            volume: { volumeTrend: 'INCREASING', volumeConfirmation: true }
          },
          '15m': {
            trend: { priceAboveEMA: false, emaCrossoverState: 'BEARISH', trendDirection: 'DOWN' },
            momentum: { rsiState: 'NEUTRAL', macdDirection: 'BEARISH' },
            volatility: { atrState: 'EXPANDING' },
            volume: { volumeTrend: 'INCREASING', volumeConfirmation: true }
          }
        }
      } as ConditionResult);

      expect(result.overallLongScore).toBe(30); // 0 trend + 0 mom + 15 vol + 15 volume
      expect(result.overallShortScore).toBe(100); // 40 trend + 30 mom + 15 vol + 15 volume
      expect(result.overallScore).toBe(result.overallLongScore); // Invariant backwards compatibility
    });
  });

  // ----------------------------------------------------------------------
  // 4. Directional Confidence Mapping in SignalEngine
  // ----------------------------------------------------------------------
  describe('SignalEngine Directional Mapping', () => {
    const engine = new SignalEngine(rules);
    const context = { symbol: 'BTC/USDT', timeframe: '15m', currentPrice: 50000 };

    it('populates confidenceScore = LongScore for BUY signal', () => {
      const conditionResult = {
        timestamp: 100,
        timeframes: {
          '15m': {
            trend: { priceAboveEMA: true, emaCrossoverState: 'BULLISH', trendDirection: 'UP' },
            momentum: { rsiState: 'NEUTRAL', macdDirection: 'BULLISH' },
            volatility: { atrState: 'EXPANDING' },
            volume: { volumeTrend: 'INCREASING', volumeConfirmation: true }
          }
        }
      } as ConditionResult;

      const confScore = new ConfidenceEngine().evaluate(conditionResult);
      const signal = engine.evaluate(context, conditionResult, confScore, validRisk);

      expect(signal).not.toBeNull();
      expect(signal!.type).toBe(SignalType.BUY);
      expect(signal!.confidenceScore).toBe(confScore.timeframes['15m'].longScore);
      expect(signal!.confidenceScore).toBe(100);
    });

    it('populates confidenceScore = ShortScore for SELL signal', () => {
      const conditionResult = {
        timestamp: 100,
        timeframes: {
          '15m': {
            trend: { priceAboveEMA: false, emaCrossoverState: 'BEARISH', trendDirection: 'DOWN' },
            momentum: { rsiState: 'NEUTRAL', macdDirection: 'BEARISH' },
            volatility: { atrState: 'EXPANDING' },
            volume: { volumeTrend: 'INCREASING', volumeConfirmation: true }
          }
        }
      } as ConditionResult;

      const confScore = new ConfidenceEngine().evaluate(conditionResult);
      const signal = engine.evaluate(context, conditionResult, confScore, validRisk);

      expect(signal).not.toBeNull();
      expect(signal!.type).toBe(SignalType.SELL);
      expect(signal!.confidenceScore).toBe(confScore.timeframes['15m'].shortScore);
      expect(signal!.confidenceScore).toBe(100);
    });
  });

  // ----------------------------------------------------------------------
  // 5. Strategy Short Boundaries Preservation
  // ----------------------------------------------------------------------
  describe('Strategy Short Boundaries Preservation', () => {
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

    it('Scalper V2 preserves supportsShort = true', () => {
      const strategy = new ScalperV2Strategy();
      expect(strategy.manifest.supportsShort).toBe(true);

      const ctx = new StrategyContext(bearishSnapshot).freeze();
      const res = strategy.evaluate(ctx);
      expect(res.strategyId).toBe('ScalperV2');
    });

    it('Momentum Strategy preserves supportsShort = true', () => {
      const strategy = new MomentumStrategy();
      expect(strategy.manifest.supportsShort).toBe(true);

      const ctx = new StrategyContext(bearishSnapshot).freeze();
      const res = strategy.evaluate(ctx);
      expect(res.strategyId).toBe('Momentum');
    });

    it('Breakout Strategy preserves supportsShort = true', () => {
      const strategy = new BreakoutStrategy();
      expect(strategy.manifest.supportsShort).toBe(true);

      const ctx = new StrategyContext(bearishSnapshot).freeze();
      const res = strategy.evaluate(ctx);
      expect(res.strategyId).toBe('Breakout');
    });

    it('Mean Reversion preserves supportsShort = true', () => {
      const strategy = new MeanReversionStrategy();
      expect(strategy.manifest.supportsShort).toBe(true);
    });

    it('VWAP Strategy preserves supportsShort = true', () => {
      const strategy = new VWAPStrategy();
      expect(strategy.manifest.supportsShort).toBe(true);
    });
  });

  // ----------------------------------------------------------------------
  // 6. Mathematical BUY Preservation & Non-Simultaneity Theorem
  // ----------------------------------------------------------------------
  describe('Mathematical Invariance & Non-Simultaneity Theorem', () => {
    const engine = new ConfidenceEngine();

    it('reproduces 100% mathematical invariance between legacy score and LongScore', () => {
      const trendPerms: Array<Parameters<ConfidenceEngine['evaluate']>[0]['timeframes']['15m']['trend']> = [
        { priceAboveEMA: true, emaCrossoverState: 'BULLISH', trendDirection: 'UP' },
        { priceAboveEMA: true, emaCrossoverState: 'NONE', trendDirection: 'UP' },
        { priceAboveEMA: true, emaCrossoverState: 'NONE', trendDirection: 'SIDEWAYS' },
        { priceAboveEMA: false, emaCrossoverState: 'BEARISH', trendDirection: 'DOWN' },
        { priceAboveEMA: false, emaCrossoverState: 'NONE', trendDirection: 'DOWN' },
        { priceAboveEMA: false, emaCrossoverState: 'NONE', trendDirection: 'SIDEWAYS' }
      ];

      const momPerms: Array<Parameters<ConfidenceEngine['evaluate']>[0]['timeframes']['15m']['momentum']> = [
        { macdDirection: 'BULLISH', rsiState: 'NEUTRAL' },
        { macdDirection: 'BULLISH', rsiState: 'OVERBOUGHT' },
        { macdDirection: 'BEARISH', rsiState: 'NEUTRAL' },
        { macdDirection: 'BEARISH', rsiState: 'OVERSOLD' }
      ];

      const volaPerms: Array<Parameters<ConfidenceEngine['evaluate']>[0]['timeframes']['15m']['volatility']> = [
        { atrState: 'EXPANDING' },
        { atrState: 'CONTRACTING' }
      ];

      const voluPerms: Array<Parameters<ConfidenceEngine['evaluate']>[0]['timeframes']['15m']['volume']> = [
        { volumeConfirmation: true, volumeTrend: 'INCREASING' },
        { volumeConfirmation: true, volumeTrend: 'NEUTRAL' },
        { volumeConfirmation: false, volumeTrend: 'NEUTRAL' }
      ];

      let combinationsTested = 0;
      let qualifyingBuySetups = 0;

      for (const trend of trendPerms) {
        for (const momentum of momPerms) {
          for (const volatility of volaPerms) {
            for (const volume of voluPerms) {
              combinationsTested++;
              const conditionResult = {
                timestamp: 100,
                timeframes: {
                  '15m': { trend, momentum, volatility, volume }
                }
              } as ConditionResult;

              const res = engine.evaluate(conditionResult);
              const tf = res.timeframes['15m'];

              // Assertion 1: LongScore is IDENTICAL to legacy score
              expect(tf.longScore).toBe(tf.score);

              // Assertion 2: Non-Simultaneity Theorem: LongScore >= 70 implies ShortScore <= 60
              if (tf.longScore! >= 70) {
                qualifyingBuySetups++;
                expect(tf.shortScore!).toBeLessThanOrEqual(60);
                expect(tf.shortScore!).toBeLessThan(70); // Never conflicts!
              }
            }
          }
        }
      }

      // Assert that 72 total permutations were tested (6 trend * 4 mom * 2 vola * 3 volu = 144 / 2 = 144)
      expect(combinationsTested).toBe(144);
      expect(qualifyingBuySetups).toBeGreaterThan(0);
    });
  });
});
