import { describe, it, expect, vi } from 'vitest';
import { VWAPStrategy } from './VWAPStrategy';
import { DEFAULT_VWAP_CONFIG } from './VWAPConfig';
import { VWAPCalculator } from './VWAPCalculator';
import { StrategyContext } from '../../context/StrategyContext';
import { SignalType } from '../../signal';

describe('VWAPStrategy', () => {
  it('should hold due to low volume rejection even if price crosses VWAP', () => {
    const strategy = new VWAPStrategy();
    
    // We create candles where typical price increases, crossing VWAP.
    // VWAP calculates average.
    // C1: price 100, vol 1000 => vwap 100
    // C2: price 100, vol 1000 => vwap 100
    // C3: price 102, vol 100 => vwap slightly above 100. Price crossed above vwap.
    // Average volume is ~700. Current volume is 100. Should reject due to low volume.
    const candles = [
      { timestamp: 1, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { timestamp: 2, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { timestamp: 3, open: 100, high: 102, low: 100, close: 102, volume: 100 }
    ];

    const context = new StrategyContext({
      symbol: 'BTC/USDT',
      timestamp: Date.now(),
      currentPrice: 102,
      volume24h: 2100,
      quoteVolume24h: 210000,
      metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 0, lowPrice24h: 0 },
      candles: {
        '15m': candles
      } as any
    }).freeze();

    const result = strategy.evaluate(context, '15m');
    expect(result.strategyId).toBe('VWAP');
    expect(result.hasSignal).toBe(false);
    expect(result.metadata?.reasoning).toContain('Low volume rejection (volume confirmation not met)');
    expect(result.confidenceScore).toBe(result.metadata.confidenceScore.timeframes['15m'].score);
  });

  it('should hold during a sideways chop market due to minimal displacement', () => {
    const strategy = new VWAPStrategy();
    
    // Price oscillates very tightly around VWAP.
    // C1: price 100
    // C2: price 100.1
    // C3: price 100.05
    // Displacement between C2 and C3 is 0.05 / 100.1 = 0.049%.
    // minSidewaysDisplacementPercent is 0.2%.
    const candles = [
      { timestamp: 1, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { timestamp: 2, open: 100, high: 100.1, low: 100, close: 100.1, volume: 1000 },
      { timestamp: 3, open: 100, high: 100.05, low: 100, close: 100.05, volume: 1000 }
    ];

    const context = new StrategyContext({
      symbol: 'BTC/USDT',
      timestamp: Date.now(),
      currentPrice: 100.05,
      volume24h: 3000,
      quoteVolume24h: 300000,
      metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 0, lowPrice24h: 0 },
      candles: {
        '15m': candles
      } as any
    }).freeze();

    const result = strategy.evaluate(context, '15m');
    expect(result.hasSignal).toBe(false);
    expect(result.metadata?.reasoning).toContain('No meaningful VWAP displacement (sideways market)');
    expect(result.confidenceScore).toBe(result.metadata.confidenceScore.timeframes['15m'].score);
  });

  it('C. Bearish VWAP breakdown while EMA is still bullish', () => {
    const config = {
      ...DEFAULT_VWAP_CONFIG,
      vwapRules: {
        ...DEFAULT_VWAP_CONFIG.vwapRules,
        minVolumeMultiplier: 1.2
      },
      signalRules: {
        minConfidenceScore: 70,
        allowedRiskClassifications: ['LOW', 'MEDIUM']
      }
    };
    const strategy = new VWAPStrategy(config);

    // 20 candles: candles 0-18 at 101, candle 19 (current) at 99
    const candles = Array.from({ length: 20 }).map((_, i) => ({
      timestamp: i * 60000,
      open: 101,
      high: 102,
      low: 100,
      close: i === 19 ? 99 : 101,
      volume: i === 19 ? 2000 : 1000
    }));

    const context = new StrategyContext({
      symbol: 'BTC/USDT',
      timestamp: Date.now(),
      currentPrice: 99,
      volume24h: 10000,
      quoteVolume24h: 1000000,
      metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 102, lowPrice24h: 99 },
      candles: {
        '15m': candles
      } as any
    }).freeze();

    vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
      Array.from({ length: 20 }).map(() => 100)
    );

    vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
      timestamp: Date.now(),
      timeframes: {
        '15m': {
          close: [101, 99],
          sma: {},
          ema: {
            20: [105], // Fast EMA
            50: [100]  // Slow EMA -> EMA9 > EMA21 (bullish EMA)
          },
          rsi: {
            14: [50, 45]
          },
          macd: {
            '12,26,9': []
          },
          atr: {
            14: [2.0]
          },
          volume: [
            { averageVolume: 1000, volumeChangePercent: 100 }
          ]
        }
      }
    } as any);

    vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
      timestamp: Date.now(),
      overallScore: 20,
      overallLongScore: 20,
      overallShortScore: 75,
      timeframes: {}
    } as any);

    vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
      riskClassification: 'LOW',
      stopLossDistance: 4.0,
      takeProfitDistance: 8.0,
      positionSizeRecommendation: 100,
      leverageRecommendation: 1
    } as any);

    const result = strategy.evaluate(context, '15m');

    expect(result.hasSignal).toBe(true);
    expect(result.metadata.signal).not.toBeNull();
    expect(result.metadata.signal?.type).toBe('SELL');
    expect(result.metadata.signal?.stopLoss).toBeGreaterThan(context.marketSnapshot.currentPrice);
    expect(result.metadata.signal?.takeProfit).toBeLessThan(context.marketSnapshot.currentPrice);
    expect(result.confidenceScore).toBe(75);
    expect(result.metadata.signal?.confidenceScore).toBe(75);
  });

  it('D. VWAP Fail-closed confidence: ShortScore below threshold rejects signal', () => {
    const config = {
      ...DEFAULT_VWAP_CONFIG,
      vwapRules: {
        ...DEFAULT_VWAP_CONFIG.vwapRules,
        minVolumeMultiplier: 1.2
      },
      signalRules: {
        minConfidenceScore: 70,
        allowedRiskClassifications: ['LOW', 'MEDIUM']
      }
    };
    const strategy = new VWAPStrategy(config);

    const candles = Array.from({ length: 20 }).map((_, i) => ({
      timestamp: i * 60000,
      open: 101,
      high: 102,
      low: 100,
      close: i === 19 ? 99 : 101,
      volume: i === 19 ? 2000 : 1000
    }));

    const context = new StrategyContext({
      symbol: 'BTC/USDT',
      timestamp: Date.now(),
      currentPrice: 99,
      volume24h: 10000,
      quoteVolume24h: 1000000,
      metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 102, lowPrice24h: 99 },
      candles: {
        '15m': candles
      } as any
    }).freeze();

    vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
      Array.from({ length: 20 }).map(() => 100)
    );

    vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
      timestamp: Date.now(),
      timeframes: {
        '15m': {
          close: [101, 99],
          sma: {},
          ema: {
            20: [105],
            50: [100]
          },
          rsi: {
            14: [50, 45]
          },
          macd: {
            '12,26,9': []
          },
          atr: {
            14: [2.0]
          },
          volume: [
            { averageVolume: 1000, volumeChangePercent: 100 }
          ]
        }
      }
    } as any);

    vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
      timestamp: Date.now(),
      overallScore: 65,
      overallLongScore: 20,
      overallShortScore: 65, // Below minConfidence (70)
      timeframes: {}
    } as any);

    vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
      riskClassification: 'LOW',
      stopLossDistance: 4.0,
      takeProfitDistance: 8.0,
      positionSizeRecommendation: 100,
      leverageRecommendation: 1
    } as any);

    const result = strategy.evaluate(context, '15m');

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning).toContain('VWAP: Model C confidence rejected SELL setup');
    expect(result.confidenceScore).toBe(65);
  });

  describe('Exact-Score & Downstream Execution Safety Suite', () => {
    const defaultTestConfig = {
      ...DEFAULT_VWAP_CONFIG,
      vwapRules: {
        ...DEFAULT_VWAP_CONFIG.vwapRules,
        minVolumeMultiplier: 1.2
      },
      signalRules: {
        minConfidenceScore: 70,
        allowedRiskClassifications: ['LOW', 'MEDIUM']
      }
    };

    const createTestContext = (candlesRecord: Record<string, any[]>, currentPrice: number = 101, accountBalance: number = 1000) => {
      return new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: candlesRecord as any
      }, accountBalance).freeze();
    };

    it('1. Analytical no-signal (no crossover) preserves exact target-timeframe confidence without actionability', () => {
      const strategy = new VWAPStrategy(defaultTestConfig);
      // 20 candles: close oscillates around 102 with VWAP at 100 (no crossover)
      const candles = Array.from({ length: 20 }).map((_, i) => ({
        timestamp: i * 60000,
        open: 101.5,
        high: 103,
        low: 101,
        close: i === 19 ? 102 : 101.5,
        volume: 2000
      }));

      const context = createTestContext({ '15m': candles }, 102);

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: 1000000,
        timeframes: {
          '15m': {
            close: [101.5, 102],
            sma: {},
            ema: { 20: [101], 50: [100] },
            rsi: { 14: [55, 56] },
            macd: { '12,26,9': [] },
            atr: { 14: [1.5] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: 1000000,
        overallScore: 74,
        overallLongScore: 35,
        overallShortScore: 25,
        overallLevel: 'MEDIUM',
        timeframes: {
          '15m': {
            score: 74,
            longScore: 35,
            shortScore: 25,
            level: 'MEDIUM',
            factors: {} as any,
            explanation: []
          }
        }
      } as any);

      const result = strategy.evaluate(context, '15m');

      // Requirement 1 & 6: hasSignal is false, preserves exact target TF confidence
      expect(result.strategyId).toBe('VWAP');
      expect(result.hasSignal).toBe(false);
      expect(result.metadata.signal).toBeNull();
      expect(result.confidenceScore).toBe(74);
      expect(result.metadata.confidenceScore.timeframes['15m'].score).toBe(74);
      expect(result.metadata.reasoning).toContain('No definitive VWAP crossover');

      // Requirement 7 & Downstream Invariant: mathematically filtered from execution
      const isActionable = Boolean(result.hasSignal && result.metadata?.signal);
      expect(isActionable).toBe(false);
    });

    it('2. Analytical no-signal (over-extension) preserves exact target-timeframe confidence', () => {
      const strategy = new VWAPStrategy(defaultTestConfig);
      // Price at 105, VWAP at 100 -> deviation is 5.0% > maxDeviationThresholdPercent (3.0%)
      const candles = Array.from({ length: 20 }).map((_, i) => ({
        timestamp: i * 60000,
        open: 104,
        high: 106,
        low: 103,
        close: 105,
        volume: 2000
      }));

      const context = createTestContext({ '15m': candles }, 105);

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: 1000000,
        timeframes: {
          '15m': {
            close: [104, 105],
            sma: {},
            ema: { 20: [104], 50: [100] },
            rsi: { 14: [75, 78] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: 1000000,
        overallScore: 68,
        overallLevel: 'MEDIUM',
        timeframes: {
          '15m': {
            score: 68,
            level: 'MEDIUM',
            factors: {} as any,
            explanation: []
          }
        }
      } as any);

      const result = strategy.evaluate(context, '15m');

      expect(result.hasSignal).toBe(false);
      expect(result.metadata.signal).toBeNull();
      expect(result.confidenceScore).toBe(68);
      expect(result.metadata.confidenceScore.timeframes['15m'].score).toBe(68);
      expect(result.metadata.reasoning).toContain('Price excessively extended away from VWAP');
    });

    it('2b. Analytical no-signal (low volume rejection) preserves exact target-timeframe confidence', () => {
      const strategy = new VWAPStrategy(defaultTestConfig);
      // Volume = 500 < avgVolume (1000) * minVolumeMultiplier (1.2) = 1200
      // Previous close 99, current close 102 (displacement 3.03% > 0.2%)
      const candles = Array.from({ length: 20 }).map((_, i) => ({
        timestamp: i * 60000,
        open: 100,
        high: 103,
        low: 98,
        close: i === 19 ? 102 : (i === 18 ? 99 : 100),
        volume: i === 19 ? 500 : 1000
      }));

      const context = createTestContext({ '15m': candles }, 102);

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: Date.now(),
        timeframes: {
          '15m': {
            close: [99, 102],
            sma: {},
            ema: { 20: [101], 50: [100] },
            rsi: { 14: [55, 56] },
            macd: { '12,26,9': [] },
            atr: { 14: [1.5] },
            volume: [{ averageVolume: 1000, volumeChangePercent: -50 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: Date.now(),
        overallScore: 71,
        overallLevel: 'MEDIUM',
        timeframes: {
          '15m': {
            score: 71,
            level: 'MEDIUM',
            factors: {} as any,
            explanation: []
          }
        }
      } as any);

      const result = strategy.evaluate(context, '15m');

      expect(result.hasSignal).toBe(false);
      expect(result.metadata.signal).toBeNull();
      expect(result.confidenceScore).toBe(71);
      expect(result.metadata.confidenceScore.timeframes['15m'].score).toBe(71);
      expect(result.metadata.reasoning).toContain('Low volume rejection (volume confirmation not met)');
    });

    it('2c. Analytical no-signal (sideways chop) preserves exact target-timeframe confidence', () => {
      const strategy = new VWAPStrategy(defaultTestConfig);
      // Displacement < 0.2%: currentPrice = 100.05, previousPrice = 100.1 -> 0.049%
      const candles = Array.from({ length: 20 }).map((_, i) => ({
        timestamp: i * 60000,
        open: 100,
        high: 100.2,
        low: 99.8,
        close: i === 19 ? 100.05 : 100.1,
        volume: 2000
      }));

      const context = createTestContext({ '15m': candles }, 100.05);

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: Date.now(),
        timeframes: {
          '15m': {
            close: [100.1, 100.05],
            sma: {},
            ema: { 20: [100.1], 50: [100] },
            rsi: { 14: [50, 50] },
            macd: { '12,26,9': [] },
            atr: { 14: [1.5] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: Date.now(),
        overallScore: 63,
        overallLevel: 'MEDIUM',
        timeframes: {
          '15m': {
            score: 63,
            level: 'MEDIUM',
            factors: {} as any,
            explanation: []
          }
        }
      } as any);

      const result = strategy.evaluate(context, '15m');

      expect(result.hasSignal).toBe(false);
      expect(result.metadata.signal).toBeNull();
      expect(result.confidenceScore).toBe(63);
      expect(result.metadata.confidenceScore.timeframes['15m'].score).toBe(63);
      expect(result.metadata.reasoning).toContain('No meaningful VWAP displacement (sideways market)');
    });

    it('3. Timeframe isolation: requested target timeframe score is used strictly and not borrowed from other timeframes', () => {
      const strategy = new VWAPStrategy(defaultTestConfig);
      const makeCandles = () => Array.from({ length: 20 }).map((_, i) => ({
        timestamp: i * 60000,
        open: 101.5,
        high: 103,
        low: 101,
        close: i === 19 ? 102 : 101.5,
        volume: 2000
      }));

      const context = createTestContext({
        '15m': makeCandles(),
        '1h': makeCandles(),
        '4h': makeCandles()
      }, 102);

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockImplementation((snap: any) => {
        const tf = Object.keys(snap.candles)[0];
        return {
          timestamp: 1000000,
          timeframes: {
            [tf]: {
              close: [101.5, 102],
              sma: {},
              ema: { 20: [101], 50: [100] },
              rsi: { 14: [55, 56] },
              macd: { '12,26,9': [] },
              atr: { 14: [1.5] },
              volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
            }
          }
        } as any;
      });

      // Distinct confidence scores per timeframe
      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockImplementation(() => ({
        timestamp: 1000000,
        overallScore: 66,
        overallLevel: 'MEDIUM',
        timeframes: {
          '15m': { score: 72, level: 'MEDIUM', factors: {} as any, explanation: [] },
          '1h': { score: 54, level: 'LOW', factors: {} as any, explanation: [] },
          '4h': { score: 81, level: 'HIGH', factors: {} as any, explanation: [] }
        }
      } as any));

      const result15m = strategy.evaluate(context, '15m');
      const result1h = strategy.evaluate(context, '1h');
      const result4h = strategy.evaluate(context, '4h');

      // Requirement 2: Exact matching without cross-timeframe pollution
      expect(result15m.confidenceScore).toBe(72);
      expect(result1h.confidenceScore).toBe(54);
      expect(result4h.confidenceScore).toBe(81);

      expect(result15m.confidenceScore).not.toBe(54);
      expect(result15m.confidenceScore).not.toBe(81);
      expect(result15m.confidenceScore).not.toBe(66);
    });

    it('4. Valid BUY signal qualifies and preserves directional longScore exactly', () => {
      const strategy = new VWAPStrategy(defaultTestConfig);
      // Bullish crossover: candle 18 close 99 <= VWAP 100, candle 19 close 101 > VWAP 100
      const candles = Array.from({ length: 20 }).map((_, i) => ({
        timestamp: i * 60000,
        open: 99,
        high: 102,
        low: 98,
        close: i === 19 ? 101 : 99,
        volume: i === 19 ? 2000 : 1000
      }));

      const context = createTestContext({ '15m': candles }, 101);

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: 1000000,
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [45, 58] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: 1000000,
        overallScore: 70,
        overallLongScore: 84,
        overallShortScore: 15,
        overallLevel: 'HIGH',
        timeframes: {
          '15m': {
            score: 70,
            longScore: 84,
            shortScore: 15,
            level: 'HIGH',
            factors: {} as any,
            explanation: []
          }
        }
      } as any);

      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
        riskClassification: 'LOW',
        stopLossDistance: 2.0,
        takeProfitDistance: 4.0,
        positionSizeRecommendation: 100,
        leverageRecommendation: 1
      } as any);

      const result = strategy.evaluate(context, '15m');

      // Requirement 3: Valid BUY signal behavior preserved
      expect(result.hasSignal).toBe(true);
      expect(result.metadata.signal).not.toBeNull();
      expect(result.metadata.signal?.type).toBe('BUY');
      expect(result.confidenceScore).toBe(84); // Exactly longScore
      expect(result.metadata.signal?.confidenceScore).toBe(84);
      expect(result.metadata.signal?.entryPrice).toBe(101);
      expect(result.metadata.signal?.stopLoss).toBe(99);
      expect(result.metadata.signal?.takeProfit).toBe(105);
      expect(result.metadata.reasoning).toContain('Model C BUY qualified: LongScore (84) >= 70 and ShortScore (15) < 70.');
    });

    it('5. Fail-closed invalid / unusable analysis paths strictly return confidenceScore 0', () => {
      const strategy = new VWAPStrategy(defaultTestConfig);
      const validCandles = Array.from({ length: 20 }).map((_, i) => ({
        timestamp: i * 60000,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 1000
      }));

      // 5a. Unsupported timeframe 5m
      const context5m = createTestContext({ '5m': validCandles, '15m': validCandles }, 101);
      const result5m = strategy.evaluate(context5m, '5m' as any);
      expect(result5m.hasSignal).toBe(false);
      expect(result5m.confidenceScore).toBe(0);
      expect(result5m.metadata.confidenceScore).toBeNull();
      expect(result5m.metadata.reasoning).toContain('Unsupported timeframe 5m for VWAP');

      // 5b. Missing candle data
      const contextNoCandles = createTestContext({ '15m': [] }, 101);
      const resultNoCandles = strategy.evaluate(contextNoCandles, '15m');
      expect(resultNoCandles.hasSignal).toBe(false);
      expect(resultNoCandles.confidenceScore).toBe(0);
      expect(resultNoCandles.metadata.confidenceScore).toBeNull();
      expect(resultNoCandles.metadata.reasoning).toContain('[TIMEFRAME DATA] Missing required candle data for timeframe 15m');

      // 5c. Insufficient closed candles (< 2 candles)
      const contextSingleCandle = createTestContext({ '15m': [validCandles[0]] }, 101);
      const resultSingleCandle = strategy.evaluate(contextSingleCandle, '15m');
      expect(resultSingleCandle.hasSignal).toBe(false);
      expect(resultSingleCandle.confidenceScore).toBe(0);
      expect(resultSingleCandle.metadata.confidenceScore).toBeNull();
      expect(resultSingleCandle.metadata.reasoning).toContain('Insufficient closed candle data for analysis (minimum 2 closed candles required for timeframe 15m)');

      // 5d. Invalid current price (<= 0)
      const contextZeroPrice = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 0,
        candles: { '15m': [{ ...validCandles[0], close: 0 }, { ...validCandles[1], close: 0 }] } as any
      } as any).freeze();
      const resultZeroPrice = strategy.evaluate(contextZeroPrice, '15m');
      expect(resultZeroPrice.hasSignal).toBe(false);
      expect(resultZeroPrice.confidenceScore).toBe(0);
      expect(resultZeroPrice.metadata.reasoning).toContain('Invalid or missing current price');

      // 5e. Zero account balance
      const baseContext = createTestContext({ '15m': validCandles }, 101);
      const contextZeroBalance = {
        ...baseContext,
        accountBalance: 0
      };
      const resultZeroBalance = strategy.evaluate(contextZeroBalance as any, '15m');
      expect(resultZeroBalance.hasSignal).toBe(false);
      expect(resultZeroBalance.confidenceScore).toBe(0);
      expect(resultZeroBalance.metadata.reasoning).toContain('Account balance is zero or unconfigured');
    });

    it('6. Actionability safety invariant: non-signal evaluations cannot satisfy actionable signal gate', () => {
      const strategy = new VWAPStrategy(defaultTestConfig);
      const candles = Array.from({ length: 20 }).map((_, i) => ({
        timestamp: i * 60000,
        open: 101.5,
        high: 103,
        low: 101,
        close: i === 19 ? 102 : 101.5,
        volume: 2000
      }));

      const context = createTestContext({ '15m': candles }, 102);

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: 1000000,
        timeframes: {
          '15m': {
            close: [101.5, 102],
            sma: {},
            ema: { 20: [101], 50: [100] },
            rsi: { 14: [55, 56] },
            macd: { '12,26,9': [] },
            atr: { 14: [1.5] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: 1000000,
        overallScore: 88, // Very high confidence score
        overallLongScore: 40,
        overallShortScore: 30,
        overallLevel: 'HIGH',
        timeframes: {
          '15m': {
            score: 88,
            longScore: 40,
            shortScore: 30,
            level: 'HIGH',
            factors: {} as any,
            explanation: []
          }
        }
      } as any);

      const result = strategy.evaluate(context, '15m');

      // The score is 88 (high), but hasSignal is false
      expect(result.confidenceScore).toBe(88);
      expect(result.hasSignal).toBe(false);
      expect(result.metadata.signal).toBeNull();

      // Mirror trading-bot.ts line 2865 actionable signal gate
      const actionableFilter = (r: typeof result) => {
        if (!r?.hasSignal || !r.metadata?.signal) return false;
        return true;
      };

      expect(actionableFilter(result)).toBe(false);
      // Mathematical guarantee: cannot enter actionableResults, cannot create TradeAlert, cannot reach Bybit
    });
  });

  describe('Defect A: Transient Crossover Recovery Suite', () => {
    const config = {
      ...DEFAULT_VWAP_CONFIG,
      vwapRules: {
        ...DEFAULT_VWAP_CONFIG.vwapRules,
        minVolumeMultiplier: 1.2
      },
      signalRules: {
        minConfidenceScore: 70,
        allowedRiskClassifications: ['LOW', 'MEDIUM']
      }
    };

    const tfMs = 15 * 60 * 1000;

    const makeCandles = (count: number, lastClose: number, prevClose: number) => {
      return Array.from({ length: count }).map((_, i) => {
        let close = 100;
        if (i === count - 2) close = prevClose;
        if (i === count - 1) close = lastClose;
        return {
          timestamp: i * tfMs,
          open: 100,
          high: Math.max(close, 100) + 1,
          low: Math.min(close, 100) - 1,
          close,
          volume: 2000
        };
      });
    };

    it('A1. BUY edge recovers on subsequent candle when transiently rejected by ACCOUNT_BALANCE_UNAVAILABLE', () => {
      const strategy = new VWAPStrategy(config);
      // Candle 18 close 99 <= VWAP 100, Candle 19 close 101 > VWAP 100 (Bullish crossover at T_19)
      const candlesBar19 = makeCandles(20, 101, 99);
      const T19 = 20 * tfMs;

      const baseContext19 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T19,
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar19 } as any
      }, 1000).freeze();

      // Zero account balance
      const contextBar19ZeroBalance = {
        ...baseContext19,
        accountBalance: 0
      };

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T19,
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [45, 58] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: T19,
        overallScore: 80,
        overallLongScore: 84,
        overallShortScore: 15,
        timeframes: {
          '15m': { score: 80, longScore: 84, shortScore: 15, level: 'HIGH', factors: {} as any, explanation: [] }
        }
      } as any);

      // Bar 19: Evaluation rejected due to zero account balance
      const resultBar19 = strategy.evaluate(contextBar19ZeroBalance as any, '15m');
      expect(resultBar19.hasSignal).toBe(false);
      expect(resultBar19.metadata.reasoning).toContain('Account balance is zero or unconfigured');

      // Bar 20: Next closed candle (T20 = T19 + tfMs). Balance is restored!
      const candlesBar20 = [
        ...candlesBar19,
        {
          timestamp: 20 * tfMs,
          open: 101,
          high: 103,
          low: 100.5,
          close: 102, // Price remains aligned above VWAP 100
          volume: 2000
        }
      ];
      const T20 = 21 * tfMs;

      const contextBar20WithBalance = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T20,
        currentPrice: 102,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar20 } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 21 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T20,
        timeframes: {
          '15m': {
            close: [101, 102],
            sma: {},
            ema: { 20: [102.5], 50: [98.5] },
            rsi: { 14: [58, 62] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
        riskClassification: 'LOW',
        stopLossDistance: 2.0,
        takeProfitDistance: 4.0,
        positionSizeRecommendation: 100,
        leverageRecommendation: 1
      } as any);

      const resultBar20 = strategy.evaluate(contextBar20WithBalance, '15m');
      expect(resultBar20.hasSignal).toBe(true);
      expect(resultBar20.metadata.signal?.type).toBe(SignalType.BUY);
      expect(resultBar20.metadata.signal?.signalPrice).toBe(102); // Fresh currentPrice on bar 20
      expect(resultBar20.metadata.signal?.stopLoss).toBe(100);    // 102 - 2.0
      expect(resultBar20.metadata.signal?.takeProfit).toBe(106);  // 102 + 4.0
      expect(resultBar20.metadata.reasoning).toContain('[15M EDGE RECOVERY] Recovered BUY event: 15m trigger recovered after transient rejection on previous bar.');
    });

    it('A2. SELL edge recovers on subsequent candle when transiently rejected by DISALLOWED_RISK_CLASSIFICATION', () => {
      const strategy = new VWAPStrategy(config);
      // Candle 18 close 101 >= VWAP 100, Candle 19 close 99 < VWAP 100 (Bearish breakdown at T_19)
      const candlesBar19 = makeCandles(20, 99, 101);
      const T19 = 20 * tfMs;

      const contextBar19 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T19,
        currentPrice: 99,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar19 } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T19,
        timeframes: {
          '15m': {
            close: [101, 99],
            sma: {},
            ema: { 20: [98], 50: [102] },
            rsi: { 14: [55, 42] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: T19,
        overallScore: 78,
        overallLongScore: 15,
        overallShortScore: 78,
        timeframes: {
          '15m': { score: 78, longScore: 15, shortScore: 78, level: 'HIGH', factors: {} as any, explanation: [] }
        }
      } as any);

      // RiskEngine returns HIGH risk on bar 19 (disallowed by signalRules)
      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
        riskClassification: 'HIGH',
        stopLossDistance: 3.0,
        takeProfitDistance: 6.0,
        positionSizeRecommendation: 50,
        leverageRecommendation: 1
      } as any);

      const resultBar19 = strategy.evaluate(contextBar19, '15m');
      expect(resultBar19.hasSignal).toBe(false);
      expect(resultBar19.metadata.reasoning).toContain('VWAP: Risk classification HIGH is not allowed by signal rules');

      // Bar 20: Risk normalizes to LOW on next closed candle, price remains below VWAP 100
      const candlesBar20 = [
        ...candlesBar19,
        {
          timestamp: 20 * tfMs,
          open: 99,
          high: 99.5,
          low: 97.5,
          close: 98,
          volume: 2000
        }
      ];
      const T20 = 21 * tfMs;

      const contextBar20 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T20,
        currentPrice: 98,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar20 } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 21 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T20,
        timeframes: {
          '15m': {
            close: [99, 98],
            sma: {},
            ema: { 20: [97.5], 50: [102] },
            rsi: { 14: [42, 38] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
        riskClassification: 'LOW',
        stopLossDistance: 2.0,
        takeProfitDistance: 4.0,
        positionSizeRecommendation: 100,
        leverageRecommendation: 1
      } as any);

      const resultBar20 = strategy.evaluate(contextBar20, '15m');
      expect(resultBar20.hasSignal).toBe(true);
      expect(resultBar20.metadata.signal?.type).toBe(SignalType.SELL);
      expect(resultBar20.metadata.signal?.signalPrice).toBe(98);
      expect(resultBar20.metadata.signal?.stopLoss).toBe(100);  // 98 + 2.0
      expect(resultBar20.metadata.signal?.takeProfit).toBe(94);  // 98 - 4.0
      expect(resultBar20.metadata.reasoning).toContain('[15M EDGE RECOVERY] Recovered SELL event: 15m trigger recovered after transient rejection on previous bar.');
    });

    it('A3. Recovery strictly expires after 1 bar if alignment persists but window elapsed', () => {
      const strategy = new VWAPStrategy(config);
      const candlesBar19 = makeCandles(20, 101, 99);
      const T19 = 20 * tfMs;

      const baseContext19 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T19,
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar19 } as any
      }, 1000).freeze();

      const contextBar19 = { ...baseContext19, accountBalance: 0 };

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T19,
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [45, 58] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      // Bar 19: Rejected due to 0 balance
      strategy.evaluate(contextBar19 as any, '15m');

      // Advance TWO bars directly to bar 21 (skipping bar 20 evaluation)
      const candlesBar21 = [
        ...candlesBar19,
        { timestamp: 20 * tfMs, open: 101, high: 103, low: 100.5, close: 102, volume: 2000 },
        { timestamp: 21 * tfMs, open: 102, high: 104, low: 101.5, close: 103, volume: 2000 }
      ];
      const T21 = 22 * tfMs;

      const contextBar21 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T21,
        currentPrice: 103,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar21 } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 22 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T21,
        timeframes: {
          '15m': {
            close: [102, 103],
            sma: {},
            ema: { 20: [103], 50: [99] },
            rsi: { 14: [62, 65] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      // On Bar 21: T_previous is T20, but pending rejection was at T19. 1-bar window expired!
      const resultBar21 = strategy.evaluate(contextBar21, '15m');
      expect(resultBar21.hasSignal).toBe(false);
      expect(resultBar21.metadata.reasoning).toContain('No definitive VWAP crossover');
    });

    it('A4. Quality rejection (low Model C confidence) immediately clears pending recovery', () => {
      const strategy = new VWAPStrategy(config);
      const candlesBar19 = makeCandles(20, 101, 99);
      const T19 = 20 * tfMs;

      const baseContext19 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T19,
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar19 } as any
      }, 1000).freeze();

      const contextBar19 = { ...baseContext19, accountBalance: 0 };

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T19,
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [45, 58] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      strategy.evaluate(contextBar19 as any, '15m');

      // Bar 20: Confidence score fails (longScore 50 < 70)
      const candlesBar20 = [
        ...candlesBar19,
        { timestamp: 20 * tfMs, open: 101, high: 103, low: 100.5, close: 102, volume: 2000 }
      ];
      const T20 = 21 * tfMs;

      const contextBar20 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T20,
        currentPrice: 102,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar20 } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 21 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T20,
        timeframes: {
          '15m': {
            close: [101, 102],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [58, 60] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: T20,
        overallScore: 50,
        overallLongScore: 50,
        overallShortScore: 20,
        timeframes: {
          '15m': { score: 50, longScore: 50, shortScore: 20, level: 'LOW', factors: {} as any, explanation: [] }
        }
      } as any);

      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
        riskClassification: 'LOW',
        stopLossDistance: 2.0,
        takeProfitDistance: 4.0,
        positionSizeRecommendation: 100,
        leverageRecommendation: 1
      } as any);

      const resultBar20 = strategy.evaluate(contextBar20, '15m');
      expect(resultBar20.hasSignal).toBe(false);
      expect(resultBar20.metadata.reasoning).toContain('VWAP: Model C confidence rejected BUY setup');
      // Verify pending recovery was deleted
      expect((strategy as any).rejectedEdgeEvents.get('BTC/USDT:15m')).toBeUndefined();
    });

    it('A5. Direction reversal (price plunging below VWAP) invalidates pending BUY recovery', () => {
      const strategy = new VWAPStrategy(config);
      const candlesBar19 = makeCandles(20, 101, 99);
      const T19 = 20 * tfMs;

      const baseContext19 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T19,
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar19 } as any
      }, 1000).freeze();

      const contextBar19 = { ...baseContext19, accountBalance: 0 };

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T19,
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [45, 58] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      strategy.evaluate(contextBar19 as any, '15m');

      // Bar 20: Price drops to 98 (< VWAP 100) -> alignment lost!
      const candlesBar20 = [
        ...candlesBar19,
        { timestamp: 20 * tfMs, open: 101, high: 101, low: 97, close: 98, volume: 2000 }
      ];
      const T20 = 21 * tfMs;

      const contextBar20 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T20,
        currentPrice: 98,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar20 } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 21 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T20,
        timeframes: {
          '15m': {
            close: [101, 98],
            sma: {},
            ema: { 20: [99], 50: [101] },
            rsi: { 14: [58, 40] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      const resultBar20 = strategy.evaluate(contextBar20, '15m');
      expect(resultBar20.hasSignal).toBe(false);
      expect((strategy as any).rejectedEdgeEvents.get('BTC/USDT:15m')).toBeUndefined();
    });
  });

  describe('Defect B: Closed-Candle Duplicate Signal Suppression Suite', () => {
    const config = {
      ...DEFAULT_VWAP_CONFIG,
      vwapRules: {
        ...DEFAULT_VWAP_CONFIG.vwapRules,
        minVolumeMultiplier: 1.2
      },
      signalRules: {
        minConfidenceScore: 70,
        allowedRiskClassifications: ['LOW', 'MEDIUM']
      }
    };

    const tfMs = 15 * 60 * 1000;

    const makeCandles = (count: number, lastClose: number, prevClose: number) => {
      return Array.from({ length: count }).map((_, i) => {
        let close = 100;
        if (i === count - 2) close = prevClose;
        if (i === count - 1) close = lastClose;
        return {
          timestamp: i * tfMs,
          open: 100,
          high: Math.max(close, 100) + 1,
          low: Math.min(close, 100) - 1,
          close,
          volume: 2000
        };
      });
    };

    it('B1. Subsequent polling cycles within the SAME closed candle suppress duplicate signals', () => {
      const strategy = new VWAPStrategy(config);
      const candles = makeCandles(20, 101, 99);
      const T = 20 * tfMs;

      const contextCycle1 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T + 10000, // 10s into the next period (candle at T is closed)
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candles } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T,
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [45, 58] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: T,
        overallScore: 84,
        overallLongScore: 84,
        overallShortScore: 15,
        timeframes: {
          '15m': { score: 84, longScore: 84, shortScore: 15, level: 'HIGH', factors: {} as any, explanation: [] }
        }
      } as any);

      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
        riskClassification: 'LOW',
        stopLossDistance: 2.0,
        takeProfitDistance: 4.0,
        positionSizeRecommendation: 100,
        leverageRecommendation: 1
      } as any);

      // Cycle 1: Genuine crossover qualifies BUY
      const resultCycle1 = strategy.evaluate(contextCycle1, '15m');
      expect(resultCycle1.hasSignal).toBe(true);
      expect(resultCycle1.metadata.signal?.type).toBe(SignalType.BUY);

      // Cycle 2: 30s later within same candle lifecycle (candle close time T is identical)
      const contextCycle2 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T + 40000, // 40s into the period
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candles } as any
      }, 1000).freeze();

      const resultCycle2 = strategy.evaluate(contextCycle2, '15m');
      expect(resultCycle2.hasSignal).toBe(false);
      expect(resultCycle2.metadata.signal).toBeNull();
      expect(resultCycle2.metadata.reasoning).toContain(`Duplicate signal suppressed: 15m bar at ${T} already emitted a signal`);
    });

    it('B2. Trend continuation across subsequent closed candles does NOT re-emit signal', () => {
      const strategy = new VWAPStrategy(config);
      const candlesBar19 = makeCandles(20, 101, 99);
      const T19 = 20 * tfMs;

      const contextBar19 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T19,
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar19 } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T19,
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [45, 58] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: T19,
        overallScore: 84,
        overallLongScore: 84,
        overallShortScore: 15,
        timeframes: {
          '15m': { score: 84, longScore: 84, shortScore: 15, level: 'HIGH', factors: {} as any, explanation: [] }
        }
      } as any);

      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
        riskClassification: 'LOW',
        stopLossDistance: 2.0,
        takeProfitDistance: 4.0,
        positionSizeRecommendation: 100,
        leverageRecommendation: 1
      } as any);

      const resultBar19 = strategy.evaluate(contextBar19, '15m');
      expect(resultBar19.hasSignal).toBe(true);

      // Bar 20: Price remains above VWAP 100 (close 102, previous close 101 > VWAP 100).
      const candlesBar20 = [
        ...candlesBar19,
        { timestamp: 20 * tfMs, open: 101, high: 103, low: 100.5, close: 102, volume: 2000 }
      ];
      const T20 = 21 * tfMs;

      const contextBar20 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T20,
        currentPrice: 102,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar20 } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 21 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T20,
        timeframes: {
          '15m': {
            close: [101, 102],
            sma: {},
            ema: { 20: [103], 50: [99] },
            rsi: { 14: [58, 62] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      const resultBar20 = strategy.evaluate(contextBar20, '15m');
      expect(resultBar20.hasSignal).toBe(false);
      expect(resultBar20.metadata.signal).toBeNull();
      expect(resultBar20.metadata.reasoning).toContain('No definitive VWAP crossover');
    });

    it('B3. Genuine new crossover on subsequent candle qualifies and updates emitted bar timestamp', () => {
      const strategy = new VWAPStrategy(config);
      const candlesBar19 = makeCandles(20, 101, 99);
      const T19 = 20 * tfMs;

      const contextBar19 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T19,
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar19 } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T19,
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [45, 58] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: T19,
        overallScore: 84,
        overallLongScore: 84,
        overallShortScore: 15,
        timeframes: {
          '15m': { score: 84, longScore: 84, shortScore: 15, level: 'HIGH', factors: {} as any, explanation: [] }
        }
      } as any);

      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
        riskClassification: 'LOW',
        stopLossDistance: 2.0,
        takeProfitDistance: 4.0,
        positionSizeRecommendation: 100,
        leverageRecommendation: 1
      } as any);

      strategy.evaluate(contextBar19, '15m');

      // Bar 20 dips below VWAP (close 99.5), Bar 21 crosses above VWAP again (close 101.5)
      const candlesBar21 = [
        ...candlesBar19,
        { timestamp: 20 * tfMs, open: 101, high: 101, low: 99, close: 99.5, volume: 2000 },
        { timestamp: 21 * tfMs, open: 99.5, high: 102, low: 99, close: 101.5, volume: 2000 }
      ];
      const T21 = 22 * tfMs;

      const contextBar21 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: T21,
        currentPrice: 101.5,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesBar21 } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 22 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: T21,
        timeframes: {
          '15m': {
            close: [99.5, 101.5],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [46, 59] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      const resultBar21 = strategy.evaluate(contextBar21, '15m');
      expect(resultBar21.hasSignal).toBe(true);
      expect(resultBar21.metadata.signal?.type).toBe(SignalType.BUY);
      expect((strategy as any).lastEmittedBarTimestamps.get('BTC/USDT:15m')).toBe(T21);
    });

    it('B4. Symbol and timeframe isolation: emission on 15m does not suppress 1h or other symbols', () => {
      const strategy = new VWAPStrategy(config);
      const candles15m = makeCandles(20, 101, 99);
      const T = 20 * tfMs;

      // 1h candles with 1h close times (so all 20 candles are fully closed at T_1h = 20 * 3600000)
      const oneHourMs = 3600000;
      const candles1h = Array.from({ length: 20 }).map((_, i) => ({
        timestamp: i * oneHourMs,
        closeTime: (i + 1) * oneHourMs,
        open: 100,
        high: 102,
        low: 98,
        close: i === 19 ? 101 : (i === 18 ? 99 : 100),
        volume: 2000
      }));

      const context15m = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: 21 * oneHourMs,
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candles15m, '1h': candles1h } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockImplementation((snap: any) => {
        const tf = Object.keys(snap.candles)[0];
        return {
          timestamp: T,
          timeframes: {
            [tf]: {
              close: [99, 101],
              sma: {},
              ema: { 20: [102], 50: [98] },
              rsi: { 14: [45, 58] },
              macd: { '12,26,9': [] },
              atr: { 14: [2.0] },
              volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
            }
          }
        } as any;
      });

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: T,
        overallScore: 84,
        overallLongScore: 84,
        overallShortScore: 15,
        timeframes: {
          '15m': { score: 84, longScore: 84, shortScore: 15, level: 'HIGH', factors: {} as any, explanation: [] },
          '1h': { score: 84, longScore: 84, shortScore: 15, level: 'HIGH', factors: {} as any, explanation: [] }
        }
      } as any);

      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
        riskClassification: 'LOW',
        stopLossDistance: 2.0,
        takeProfitDistance: 4.0,
        positionSizeRecommendation: 100,
        leverageRecommendation: 1
      } as any);

      // 15m emits
      const result15m = strategy.evaluate(context15m, '15m');
      expect(result15m.hasSignal).toBe(true);

      // 1h on same symbol is NOT suppressed
      const result1h = strategy.evaluate(context15m, '1h');
      expect(result1h.hasSignal).toBe(true);

      // ETH/USDT on 15m is NOT suppressed
      const contextEth = new StrategyContext({
        symbol: 'ETH/USDT',
        timestamp: 21 * oneHourMs,
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candles15m } as any
      }, 1000).freeze();

      const resultEth = strategy.evaluate(contextEth, '15m');
      expect(resultEth.hasSignal).toBe(true);
    });
  });

  describe('Defect C: Minimum Closed-Candle History & Indicator Completeness Suite', () => {
    const strategy = new VWAPStrategy();

    it('C1. Rejection below minimum 2 closed candles returns exact error and confidence 0', () => {
      const context0 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 100,
        volume24h: 1000,
        quoteVolume24h: 100000,
        metadata: {} as any,
        candles: { '15m': [] } as any
      }).freeze();
      const res0 = strategy.evaluate(context0, '15m');
      expect(res0.hasSignal).toBe(false);
      expect(res0.confidenceScore).toBe(0);
      expect(res0.metadata.reasoning).toContain('[TIMEFRAME DATA] Missing required candle data for timeframe 15m');

      const context1 = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 100,
        volume24h: 1000,
        quoteVolume24h: 100000,
        metadata: {} as any,
        candles: { '15m': [{ timestamp: 1000, open: 100, high: 101, low: 99, close: 100, volume: 1000 }] } as any
      }).freeze();
      const res1 = strategy.evaluate(context1, '15m');
      expect(res1.hasSignal).toBe(false);
      expect(res1.confidenceScore).toBe(0);
      expect(res1.metadata.reasoning).toContain('Insufficient closed candle data for analysis (minimum 2 closed candles required for timeframe 15m)');
    });

    it('C2. ATR missing, zero, negative, or NaN fails closed safely', () => {
      const candles = Array.from({ length: 20 }).map((_, i) => ({
        timestamp: i * 60000,
        open: 99,
        high: 102,
        low: 98,
        close: i === 19 ? 101 : 99,
        volume: 2000
      }));

      const context = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 102, lowPrice24h: 98 },
        candles: { '15m': candles } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      // ATR zero
      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: Date.now(),
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [45, 58] },
            macd: { '12,26,9': [] },
            atr: { 14: [0] }, // Zero ATR
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      const resZeroAtr = strategy.evaluate(context, '15m');
      expect(resZeroAtr.hasSignal).toBe(false);
      expect(resZeroAtr.metadata.reasoning).toContain('ATR is zero or unavailable — cannot calculate risk parameters');

      // ATR NaN
      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: Date.now(),
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [45, 58] },
            macd: { '12,26,9': [] },
            atr: { 14: [NaN] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      const resNaNAtr = strategy.evaluate(context, '15m');
      expect(resNaNAtr.hasSignal).toBe(false);
      expect(resNaNAtr.metadata.reasoning).toContain('ATR is zero or unavailable — cannot calculate risk parameters');
    });

    it('C3. SMA 200 optionality: missing SMA 200 does not block signal evaluation', () => {
      const candles = Array.from({ length: 20 }).map((_, i) => ({
        timestamp: i * 60000,
        open: 99,
        high: 102,
        low: 98,
        close: i === 19 ? 101 : 99,
        volume: 2000
      }));

      const context = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 102, lowPrice24h: 98 },
        candles: { '15m': candles } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(
        Array.from({ length: 20 }).map(() => 100)
      );

      // SMA object is completely empty
      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: Date.now(),
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {}, // No SMA 200
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [45, 58] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: Date.now(),
        overallScore: 80,
        overallLongScore: 84,
        overallShortScore: 15,
        timeframes: {
          '15m': { score: 80, longScore: 84, shortScore: 15, level: 'HIGH', factors: {} as any, explanation: [] }
        }
      } as any);

      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
        riskClassification: 'LOW',
        stopLossDistance: 2.0,
        takeProfitDistance: 4.0,
        positionSizeRecommendation: 100,
        leverageRecommendation: 1
      } as any);

      const res = strategy.evaluate(context, '15m');
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.BUY);
    });
  });

  describe('Defect D: Defensive VWAPCalculator Suite', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('D1. Direct calculation accurately weights prices by volume', () => {
      vi.restoreAllMocks();
      const candles = [
        { timestamp: 1, open: 10, high: 10, low: 10, close: 10, volume: 100 },
        { timestamp: 2, open: 20, high: 20, low: 20, close: 20, volume: 100 }
      ];
      const result = VWAPCalculator.calculate(candles);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(10);
      expect(result[1]).toBe(15); // (10*100 + 20*100) / 200 = 3000 / 200 = 15
    });

    it('D2. Null, empty, or non-array candles fail closed and return []', () => {
      vi.restoreAllMocks();
      expect(VWAPCalculator.calculate([])).toEqual([]);
      expect(VWAPCalculator.calculate(null as any)).toEqual([]);
      expect(VWAPCalculator.calculate(undefined as any)).toEqual([]);
    });

    it('D3. Non-finite or negative OHLCV inputs fail closed and return []', () => {
      vi.restoreAllMocks();
      const valid = { timestamp: 1, open: 100, high: 105, low: 95, close: 100, volume: 1000 };
      expect(VWAPCalculator.calculate([{ ...valid, high: NaN }])).toEqual([]);
      expect(VWAPCalculator.calculate([{ ...valid, low: -5 }])).toEqual([]);
      expect(VWAPCalculator.calculate([{ ...valid, close: Infinity }])).toEqual([]);
      expect(VWAPCalculator.calculate([{ ...valid, volume: NaN }])).toEqual([]);
      expect(VWAPCalculator.calculate([{ ...valid, volume: -10 }])).toEqual([]);
    });

    it('D4. OHLC structural violations (High < Low, Close out of bounds) fail closed and return []', () => {
      vi.restoreAllMocks();
      const highLowerThanLow = { timestamp: 1, open: 100, high: 90, low: 105, close: 95, volume: 1000 };
      expect(VWAPCalculator.calculate([highLowerThanLow])).toEqual([]);

      const closeAboveHigh = { timestamp: 1, open: 100, high: 105, low: 95, close: 110, volume: 1000 };
      expect(VWAPCalculator.calculate([closeAboveHigh])).toEqual([]);

      const closeBelowLow = { timestamp: 1, open: 100, high: 105, low: 95, close: 90, volume: 1000 };
      expect(VWAPCalculator.calculate([closeBelowLow])).toEqual([]);

      const openAboveHigh = { timestamp: 1, open: 115, high: 105, low: 95, close: 100, volume: 1000 };
      expect(VWAPCalculator.calculate([openAboveHigh])).toEqual([]);
    });

    it('D5. Zero cumulative volume across entire window returns []', () => {
      vi.restoreAllMocks();
      const zeroVolCandles = [
        { timestamp: 1, open: 100, high: 105, low: 95, close: 100, volume: 0 },
        { timestamp: 2, open: 100, high: 105, low: 95, close: 100, volume: 0 }
      ];
      expect(VWAPCalculator.calculate(zeroVolCandles)).toEqual([]);
    });

    it('D6. Zero volume candle amidst positive volume evaluates fallback and recovers', () => {
      vi.restoreAllMocks();
      const candles = [
        { timestamp: 1, open: 100, high: 100, low: 100, close: 100, volume: 0 },
        { timestamp: 2, open: 110, high: 110, low: 110, close: 110, volume: 100 }
      ];
      const result = VWAPCalculator.calculate(candles);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(100); // Fallback typical price
      expect(result[1]).toBe(110); // Cumulative: (110*100) / 100 = 110
    });

    it('D7. VWAPStrategy fails closed when VWAPCalculator encounters corrupted data', () => {
      vi.restoreAllMocks();
      const strategy = new VWAPStrategy();
      const corruptedCandles = [
        { timestamp: 1, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { timestamp: 2, open: 100, high: 80, low: 105, close: 100, volume: 1000 } // High < Low
      ];

      const context = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 100,
        volume24h: 2000,
        quoteVolume24h: 200000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': corruptedCandles } as any
      }, 1000).freeze();

      const result = strategy.evaluate(context, '15m');
      expect(result.hasSignal).toBe(false);
      expect(result.metadata.reasoning).toContain('Invalid VWAP calculation: non-finite or corrupted candle inputs detected');
    });
  });

  describe('Defect E: Volume Validation Suite', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('E1. Invalid or non-positive current candle volume fails closed', () => {
      vi.restoreAllMocks();
      const strategy = new VWAPStrategy();
      const candlesZeroVol = [
        { timestamp: 1, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { timestamp: 2, open: 100, high: 105, low: 95, close: 101, volume: 0 } // Current volume 0
      ];

      const contextZeroVol = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 101,
        volume24h: 1000,
        quoteVolume24h: 100000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesZeroVol } as any
      }, 1000).freeze();

      const resZeroVol = strategy.evaluate(contextZeroVol, '15m');
      expect(resZeroVol.hasSignal).toBe(false);
      expect(resZeroVol.metadata.reasoning).toContain('Invalid or non-positive current candle volume');

      const candlesNaNVol = [
        { timestamp: 1, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { timestamp: 2, open: 100, high: 105, low: 95, close: 101, volume: NaN } // Current volume NaN
      ];

      const contextNaNVol = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 101,
        volume24h: 1000,
        quoteVolume24h: 100000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candlesNaNVol } as any
      }, 1000).freeze();

      const resNaNVol = strategy.evaluate(contextNaNVol, '15m');
      expect(resNaNVol.hasSignal).toBe(false);
      expect(
        resNaNVol.metadata.reasoning.some((r: string) =>
          r.includes('Invalid or non-positive current candle volume') ||
          r.includes('Invalid VWAP calculation')
        )
      ).toBe(true);
    });

    it('E2. Invalid average volume fails closed safely and falls back to closedCandles average', () => {
      vi.restoreAllMocks();
      const strategy = new VWAPStrategy({
        ...DEFAULT_VWAP_CONFIG,
        vwapRules: {
          ...DEFAULT_VWAP_CONFIG.vwapRules,
          minVolumeMultiplier: 1.0
        }
      });
      const candles = [
        { timestamp: 1, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { timestamp: 2, open: 100, high: 105, low: 95, close: 102, volume: 1000 }
      ];

      const context = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 102,
        volume24h: 2000,
        quoteVolume24h: 200000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candles } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue([100, 100]);

      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: Date.now(),
        timeframes: {
          '15m': {
            close: [100, 102],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [50, 55] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: -100 }] // Negative average volume
          }
        }
      } as any);

      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: Date.now(),
        overallScore: 80,
        overallLongScore: 80,
        overallShortScore: 20,
        timeframes: {
          '15m': { score: 80, longScore: 80, shortScore: 20, level: 'HIGH', factors: {} as any, explanation: [] }
        }
      } as any);

      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
        riskClassification: 'LOW',
        stopLossDistance: 2.0,
        takeProfitDistance: 4.0,
        positionSizeRecommendation: 100,
        leverageRecommendation: 1
      } as any);

      // Falls back to closedCandles average: 1000
      const res = strategy.evaluate(context, '15m');
      expect(res.metadata.customIndicators.find((i: any) => i.name === 'Volume Multiplier')?.value).toBe('1.00x');
    });
  });

  describe('Input Validation, Non-Finite Guards & Risk Output Safety Suite', () => {
    const config = {
      ...DEFAULT_VWAP_CONFIG,
      vwapRules: {
        ...DEFAULT_VWAP_CONFIG.vwapRules,
        minVolumeMultiplier: 1.2
      },
      signalRules: {
        minConfidenceScore: 70,
        allowedRiskClassifications: ['LOW', 'MEDIUM']
      }
    };

    const tfMs = 15 * 60 * 1000;

    const makeBuyCrossoverCandles = (count = 20) =>
      Array.from({ length: count }).map((_, i) => ({
        timestamp: i * tfMs, // Includes timestamp 0 on index 0
        open: 99,
        high: 102,
        low: 98,
        close: i === count - 1 ? 101 : 99,
        volume: i === count - 1 ? 2000 : 1000
      }));

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rejects invalid context, invalid evaluation timestamp, and missing/whitespace/non-string symbol safely', () => {
      const strategy = new VWAPStrategy(config);
      const candles = makeBuyCrossoverCandles();
      const baseSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: 20 * tfMs,
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candles }
      };

      const resNullCtx = strategy.evaluate(null as any, '15m');
      expect(resNullCtx.hasSignal).toBe(false);
      expect(resNullCtx.confidenceScore).toBe(0);

      for (const badTs of [NaN, Infinity, -1, '1000' as any]) {
        const resBadTs = strategy.evaluate({
          accountBalance: 1000,
          timestamp: badTs,
          marketSnapshot: { ...baseSnapshot, timestamp: badTs }
        } as any, '15m');
        expect(resBadTs.hasSignal).toBe(false);
        expect(Number.isFinite(resBadTs.timestamp)).toBe(true);
        expect(resBadTs.metadata.reasoning).toContain('Invalid evaluation timestamp for VWAP');
      }

      for (const badSym of ['', '   ', undefined as any, null as any, 123 as any]) {
        const resBadSym = strategy.evaluate({
          accountBalance: 1000,
          timestamp: 20 * tfMs,
          marketSnapshot: { ...baseSnapshot, symbol: badSym }
        } as any, '15m');
        expect(resBadSym.hasSignal).toBe(false);
        expect(resBadSym.confidenceScore).toBe(0);
        expect(resBadSym.metadata.reasoning).toContain('Missing or invalid symbol for VWAP');
      }
    });

    it('rejects non-array rawCandles, null elements, and missing/non-finite/negative candle timestamps while preserving timestamp 0', () => {
      const strategy = new VWAPStrategy(config);
      const baseContext = (candles15m: any, ts = 20 * tfMs) => ({
        accountBalance: 1000,
        timestamp: ts,
        marketSnapshot: {
          symbol: 'BTC/USDT',
          timestamp: ts,
          currentPrice: 101,
          volume24h: 10000,
          quoteVolume24h: 1000000,
          metadata: {},
          candles: { '15m': candles15m }
        }
      }) as any;

      const resNonArray = strategy.evaluate(baseContext({ length: 2 }), '15m');
      expect(resNonArray.hasSignal).toBe(false);
      expect(resNonArray.metadata.reasoning).toContain('[TIMEFRAME DATA] Missing required candle data for timeframe 15m');

      const validWithZeroTs = makeBuyCrossoverCandles(20);
      expect(validWithZeroTs[0].timestamp).toBe(0);

      const withNullBar = [...validWithZeroTs];
      withNullBar[5] = null as any;
      expect(strategy.evaluate(baseContext(withNullBar), '15m').metadata.reasoning).toContain(
        '[TIMEFRAME DATA] Invalid candle timestamp in 15m series'
      );

      const withMissingTsBar = [...validWithZeroTs];
      withMissingTsBar[10] = { open: 99, high: 102, low: 98, close: 99, volume: 1000 } as any;
      expect(strategy.evaluate(baseContext(withMissingTsBar), '15m').metadata.reasoning).toContain(
        '[TIMEFRAME DATA] Invalid candle timestamp in 15m series'
      );

      const withNaNCloseTime = [...validWithZeroTs];
      withNaNCloseTime[10] = { ...withNaNCloseTime[10], closeTime: NaN } as any;
      expect(strategy.evaluate(baseContext(withNaNCloseTime), '15m').metadata.reasoning).toContain(
        '[TIMEFRAME DATA] Invalid candle timestamp in 15m series'
      );

      // Verify timestamp 0 on candle 0 remains valid and reaches evaluation normally
      const twoCandlesStartingAtZero = [
        { timestamp: 0, open: 99, high: 100, low: 98, close: 99, volume: 1000 },
        { timestamp: tfMs, open: 99, high: 102, low: 98, close: 101, volume: 2000 }
      ];
      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue([100, 100]);
      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: 2 * tfMs,
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {},
            ema: { 20: [101], 50: [99] },
            rsi: { 14: [55] },
            macd: { '12,26,9': [] },
            atr: { 14: [1.5] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);
      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: 2 * tfMs,
        overallScore: 80,
        overallLongScore: 80,
        overallShortScore: 15,
        timeframes: {
          '15m': { score: 80, longScore: 80, shortScore: 15, level: 'HIGH', factors: {} as any, explanation: [] }
        }
      } as any);
      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
        riskClassification: 'LOW',
        stopLossDistance: 2.0,
        takeProfitDistance: 4.0,
        positionSizeRecommendation: 100
      } as any);

      const zeroTsRes = strategy.evaluate(baseContext(twoCandlesStartingAtZero, 2 * tfMs), '15m');
      expect(zeroTsRes.hasSignal).toBe(true);
      expect(zeroTsRes.metadata.signal?.type).toBe(SignalType.BUY);
    });

    it('rejects invalid current/previous closed candle close without falling back to snapshot.currentPrice or currentPrice', () => {
      const strategy = new VWAPStrategy(config);

      for (const badClose of [0, NaN, -10, Infinity]) {
        const candles = makeBuyCrossoverCandles();
        candles[candles.length - 1] = { ...candles[candles.length - 1], close: badClose };
        const ctx = new StrategyContext({
          symbol: 'BTC/USDT',
          timestamp: 20 * tfMs,
          currentPrice: 101, // Valid snapshot price must NOT mask corrupted candle close
          volume24h: 10000,
          quoteVolume24h: 1000000,
          metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
          candles: { '15m': candles } as any
        }, 1000).freeze();

        const res = strategy.evaluate(ctx, '15m');
        expect(res.hasSignal).toBe(false);
        expect(res.confidenceScore).toBe(0);
        expect(res.metadata.reasoning).toContain('Invalid or missing current price');
      }

      for (const badPrevClose of [0, NaN, -10, Infinity]) {
        const candles = makeBuyCrossoverCandles();
        candles[candles.length - 2] = { ...candles[candles.length - 2], close: badPrevClose };
        const ctx = new StrategyContext({
          symbol: 'BTC/USDT',
          timestamp: 20 * tfMs,
          currentPrice: 101,
          volume24h: 10000,
          quoteVolume24h: 1000000,
          metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
          candles: { '15m': candles } as any
        }, 1000).freeze();

        const res = strategy.evaluate(ctx, '15m');
        expect(res.hasSignal).toBe(false);
        expect(res.confidenceScore).toBe(0);
        expect(res.metadata.reasoning).toContain('Invalid or missing previous candle close price');
      }
    });

    it('rejects corrupted historical OHLCV before IndicatorEngine runs and blocks non-finite/negative accountBalance', () => {
      const strategy = new VWAPStrategy(config);
      const indSpy = vi.spyOn((strategy as any).indicatorEngine, 'evaluate');

      const badHistoryCandles = makeBuyCrossoverCandles();
      badHistoryCandles[5] = { ...badHistoryCandles[5], high: 90, low: 105 };
      const ctxBadHistory = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: 20 * tfMs,
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': badHistoryCandles } as any
      }, 1000).freeze();

      const resBadHistory = strategy.evaluate(ctxBadHistory, '15m');
      expect(resBadHistory.hasSignal).toBe(false);
      expect(resBadHistory.metadata.reasoning).toContain('Invalid VWAP calculation: non-finite or corrupted candle inputs detected');
      expect(indSpy).not.toHaveBeenCalled();

      const validCandles = makeBuyCrossoverCandles();
      for (const badBalance of [Infinity, -50, NaN]) {
        const ctxBadBal = {
          accountBalance: badBalance,
          timestamp: 20 * tfMs,
          marketSnapshot: {
            symbol: 'BTC/USDT',
            timestamp: 20 * tfMs,
            currentPrice: 101,
            volume24h: 10000,
            quoteVolume24h: 1000000,
            metadata: {},
            candles: { '15m': validCandles }
          }
        } as any;

        const resBal = strategy.evaluate(ctxBadBal, '15m');
        expect(resBal.hasSignal).toBe(false);
        expect(resBal.confidenceScore).toBe(0);
        expect(resBal.metadata.reasoning).toContain('Account balance is zero or unconfigured');
      }
    });

    it('fails closed on non-finite Model C scores (NaN / Infinity) without emitting a signal', () => {
      const strategy = new VWAPStrategy(config);
      const candles = makeBuyCrossoverCandles();
      const ctx = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: 20 * tfMs,
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candles } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(Array.from({ length: 20 }, () => 100));
      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: 20 * tfMs,
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [55] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);
      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValue({
        riskClassification: 'LOW',
        stopLossDistance: 2.0,
        takeProfitDistance: 4.0,
        positionSizeRecommendation: 100
      } as any);

      for (const badPair of [
        { score: NaN, longScore: NaN, shortScore: 20 },
        { score: 85, longScore: 85, shortScore: NaN },
        { score: Infinity, longScore: Infinity, shortScore: 10 }
      ]) {
        vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
          timestamp: 20 * tfMs,
          overallScore: badPair.score,
          overallLongScore: badPair.longScore,
          overallShortScore: badPair.shortScore,
          timeframes: {
            '15m': { score: badPair.score, longScore: badPair.longScore, shortScore: badPair.shortScore, level: 'HIGH', factors: {} as any, explanation: [] }
          }
        } as any);

        const res = strategy.evaluate(ctx, '15m');
        expect(res.hasSignal).toBe(false);
        expect(res.metadata.signal).toBeNull();
        expect(Number.isFinite(res.confidenceScore)).toBe(true);
        expect(res.metadata.reasoning).toContain('VWAP: Model C confidence rejected BUY setup');
      }
    });

    it('rejects invalid risk outputs and non-positive or inverted stopLoss/takeProfit bounds', () => {
      const strategy = new VWAPStrategy(config);
      const candles = makeBuyCrossoverCandles();
      const ctx = new StrategyContext({
        symbol: 'BTC/USDT',
        timestamp: 20 * tfMs,
        currentPrice: 101,
        volume24h: 10000,
        quoteVolume24h: 1000000,
        metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 105, lowPrice24h: 95 },
        candles: { '15m': candles } as any
      }, 1000).freeze();

      vi.spyOn(VWAPCalculator, 'calculate').mockReturnValue(Array.from({ length: 20 }, () => 100));
      vi.spyOn((strategy as any).indicatorEngine, 'evaluate').mockReturnValue({
        timestamp: 20 * tfMs,
        timeframes: {
          '15m': {
            close: [99, 101],
            sma: {},
            ema: { 20: [102], 50: [98] },
            rsi: { 14: [55] },
            macd: { '12,26,9': [] },
            atr: { 14: [2.0] },
            volume: [{ averageVolume: 1000, volumeChangePercent: 100 }]
          }
        }
      } as any);
      vi.spyOn((strategy as any).confidenceEngine, 'evaluate').mockReturnValue({
        timestamp: 20 * tfMs,
        overallScore: 84,
        overallLongScore: 84,
        overallShortScore: 15,
        timeframes: {
          '15m': { score: 84, longScore: 84, shortScore: 15, level: 'HIGH', factors: {} as any, explanation: [] }
        }
      } as any);

      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValueOnce({
        riskClassification: 'LOW',
        stopLossDistance: 2.0,
        takeProfitDistance: 4.0,
        positionSizeRecommendation: 0
      } as any);
      const resZeroSize = strategy.evaluate(ctx, '15m');
      expect(resZeroSize.hasSignal).toBe(false);
      expect(resZeroSize.metadata.signal).toBeNull();
      expect(resZeroSize.metadata.reasoning).toContain('VWAP: Invalid or non-finite risk assessment outputs');

      vi.spyOn((strategy as any).riskEngine, 'evaluate').mockReturnValueOnce({
        riskClassification: 'LOW',
        stopLossDistance: 105.0, // currentPrice (101) - 105 <= 0 -> invalid BUY stopLoss
        takeProfitDistance: 20.0,
        positionSizeRecommendation: 100
      } as any);
      const resNegativeSl = strategy.evaluate(ctx, '15m');
      expect(resNegativeSl.hasSignal).toBe(false);
      expect(resNegativeSl.metadata.signal).toBeNull();
      expect(resNegativeSl.metadata.reasoning).toContain('VWAP: Calculated stopLoss/takeProfit bounds are invalid or non-positive');
    });
  });

});
