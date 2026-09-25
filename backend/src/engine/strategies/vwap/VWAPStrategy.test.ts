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

    const result = strategy.evaluate(context);
    expect(result.strategyId).toBe('VWAP');
    expect(result.hasSignal).toBe(false);
    expect(result.metadata?.reasoning).toContain('Low volume rejection (volume confirmation not met)');
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

    const result = strategy.evaluate(context);
    expect(result.hasSignal).toBe(false);
    expect(result.metadata?.reasoning).toContain('No meaningful VWAP displacement (sideways market)');
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

    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(true);
    expect(result.metadata.signal).not.toBeNull();
    expect(result.metadata.signal?.type).toBe('SELL');
    expect(result.metadata.signal?.stopLoss).toBeGreaterThan(context.marketSnapshot.currentPrice);
    expect(result.metadata.signal?.takeProfit).toBeLessThan(context.marketSnapshot.currentPrice);
    expect(result.confidenceScore).toBe(75);
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

    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning).toContain('VWAP: Model C confidence rejected SELL setup');
  });
});
