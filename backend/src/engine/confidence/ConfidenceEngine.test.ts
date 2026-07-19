import { describe, it, expect } from 'vitest';
import { ConfidenceEngine } from './ConfidenceEngine';
import { ConditionResult } from '../condition';

describe('ConfidenceEngine', () => {
  it('should compute high confidence for a strong bullish setup', () => {
    const engine = new ConfidenceEngine();

    const result = engine.evaluate({
      timestamp: Date.now(),
      timeframes: {
        '15m': {
          trend: {
            priceAboveEMA: true, // 50
            emaCrossoverState: 'BULLISH', // 50
            trendDirection: 'UP'
          },
          momentum: {
            rsiState: 'OVERBOUGHT', // 50
            macdDirection: 'BULLISH' // 50
          },
          volatility: {
            atrState: 'EXPANDING' // 100
          },
          volume: {
            volumeTrend: 'INCREASING', // 50
            volumeConfirmation: true // 50
          }
        }
      }
    } as ConditionResult);

    const tf = result.timeframes['15m'];
    expect(tf).toBeDefined();
    
    // Expecting 100 for all factors since it's a perfect setup
    expect(tf.factors.trendScore).toBe(100);
    expect(tf.factors.momentumScore).toBe(100);
    expect(tf.factors.volatilityScore).toBe(100);
    expect(tf.factors.volumeScore).toBe(100);

    expect(tf.score).toBe(100);
    expect(tf.level).toBe('HIGH');
    
    expect(result.overallScore).toBe(100);
    expect(result.overallLevel).toBe('HIGH');
  });

  it('should compute low confidence for weak mixed signals', () => {
    const engine = new ConfidenceEngine();

    const result = engine.evaluate({
      timestamp: Date.now(),
      timeframes: {
        '15m': {
          trend: {
            priceAboveEMA: false, // 0
            emaCrossoverState: 'NONE', // 0
            trendDirection: 'SIDEWAYS' // 0
          },
          momentum: {
            rsiState: 'NEUTRAL', // 0
            macdDirection: 'BULLISH' // 50
          },
          volatility: {
            atrState: 'CONTRACTING' // 50
          },
          volume: {
            volumeTrend: 'NEUTRAL', // 0
            volumeConfirmation: false // 0
          }
        }
      }
    } as ConditionResult);

    const tf = result.timeframes['15m'];
    
    // trend: 0 (weight 40) = 0
    // momentum: 50 (weight 30) = 15
    // volatility: 50 (weight 15) = 7.5
    // volume: 0 (weight 15) = 0
    // Total = 22.5 -> 23

    expect(tf.score).toBe(23);
    expect(tf.level).toBe('LOW');
  });
});
