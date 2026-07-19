import { describe, it, expect } from 'vitest';
import { ConditionEngine } from './ConditionEngine';
import { ConditionConfig } from './ConditionTypes';
import { IndicatorSnapshot } from '../indicator/IndicatorTypes';

describe('ConditionEngine', () => {
  const config: ConditionConfig = {
    emaFastPeriod: 10,
    emaSlowPeriod: 20,
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    macdKey: '12,26,9',
    atrPeriod: 14,
    volumePeriod: 20
  };

  it('should evaluate conditions correctly for bullish market', () => {
    const engine = new ConditionEngine(config);

    const snapshot: IndicatorSnapshot = {
      timestamp: Date.now(),
      timeframes: {
        '15m': {
          close: [90, 100, 110], // Price is rising
          rsi: {
            14: [40, 50, 75] // RSI goes overbought
          },
          sma: {},
          ema: {
            10: [80, 85, 90], // Fast EMA
            20: [85, 87, 89]  // Slow EMA
          },
          macd: {
            '12,26,9': [
              { macdLine: 1, signalLine: 0, histogram: 1 },
              { macdLine: 2, signalLine: 1, histogram: 1 },
              { macdLine: 4, signalLine: 2, histogram: 2 } // MACD histogram rising
            ]
          },
          atr: {
            14: [2, 3, 4] // Expanding ATR
          },
          volume: [
            { averageVolume: 100, volumeChangePercent: 0 },
            { averageVolume: 110, volumeChangePercent: 10 },
            { averageVolume: 120, volumeChangePercent: 25 } // Confirming volume
          ]
        }
      }
    };

    const result = engine.evaluate(snapshot);
    const tfResult = result.timeframes['15m'];

    expect(tfResult).toBeDefined();
    
    // Trend
    expect(tfResult.trend.priceAboveEMA).toBe(true); // 110 > 90
    expect(tfResult.trend.emaCrossoverState).toBe('BULLISH'); // 90 > 89 and prev 85 < 87
    expect(tfResult.trend.trendDirection).toBe('UP');

    // Momentum
    expect(tfResult.momentum.rsiState).toBe('OVERBOUGHT'); // 75 >= 70
    expect(tfResult.momentum.macdDirection).toBe('BULLISH'); // 2 > 1

    // Volatility
    expect(tfResult.volatility.atrState).toBe('EXPANDING'); // 4 > 3

    // Volume
    expect(tfResult.volume.volumeTrend).toBe('INCREASING'); // 120 > 110
    expect(tfResult.volume.volumeConfirmation).toBe(true); // 25 > 20
  });

  it('should evaluate conditions correctly for bearish market', () => {
    const engine = new ConditionEngine(config);

    const snapshot: IndicatorSnapshot = {
      timestamp: Date.now(),
      timeframes: {
        '15m': {
          close: [110, 100, 90],
          rsi: {
            14: [60, 40, 25] // RSI goes oversold
          },
          sma: {},
          ema: {
            10: [100, 98, 90], // Fast EMA crosses below Slow EMA
            20: [95, 97, 98]  // Slow EMA
          },
          macd: {
            '12,26,9': [
              { macdLine: -1, signalLine: 0, histogram: -1 },
              { macdLine: -2, signalLine: -1, histogram: -1 },
              { macdLine: -4, signalLine: -2, histogram: -2 }
            ]
          },
          atr: {
            14: [4, 3, 2] // Contracting ATR
          },
          volume: [
            { averageVolume: 120, volumeChangePercent: 0 },
            { averageVolume: 110, volumeChangePercent: -10 },
            { averageVolume: 100, volumeChangePercent: 5 } // Not confirming
          ]
        }
      }
    };

    const result = engine.evaluate(snapshot);
    const tfResult = result.timeframes['15m'];

    // Trend
    expect(tfResult.trend.priceAboveEMA).toBe(false); // 90 <= 90
    expect(tfResult.trend.emaCrossoverState).toBe('BEARISH');
    expect(tfResult.trend.trendDirection).toBe('DOWN');

    // Momentum
    expect(tfResult.momentum.rsiState).toBe('OVERSOLD');
    expect(tfResult.momentum.macdDirection).toBe('BEARISH');

    // Volatility
    expect(tfResult.volatility.atrState).toBe('CONTRACTING');

    // Volume
    expect(tfResult.volume.volumeTrend).toBe('DECREASING');
    expect(tfResult.volume.volumeConfirmation).toBe(false);
  });
});
