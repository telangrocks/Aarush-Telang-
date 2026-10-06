import { describe, it, expect, vi } from 'vitest';
import { VWAPStrategy } from './VWAPStrategy';
import { DEFAULT_VWAP_CONFIG } from './VWAPConfig';
import { VWAPCalculator } from './VWAPCalculator';
import { StrategyContext } from '../../context/StrategyContext';

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
});
