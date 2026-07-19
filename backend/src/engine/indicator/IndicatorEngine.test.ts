import { describe, it, expect } from 'vitest';
import { IndicatorEngine } from './IndicatorEngine';
import { IndicatorConfig } from './IndicatorTypes';
import { MarketSnapshot, NormalizedCandle } from '../market-data/MarketSnapshot';
import { Timeframe } from '../market-data/Timeframe';

describe('IndicatorEngine', () => {
  const config: IndicatorConfig = {
    rsiPeriods: [14],
    smaPeriods: [20],
    emaPeriods: [50],
    macdParams: [{ fast: 12, slow: 26, signal: 9 }],
    atrPeriods: [14],
    volumeAveragePeriod: 20
  };

  const engine = new IndicatorEngine(config);

  it('should evaluate indicators and produce IndicatorSnapshot', () => {
    // Generate some mock candles
    const candles: NormalizedCandle[] = [];
    let price = 100;
    for (let i = 0; i < 100; i++) {
      candles.push({
        timestamp: Date.now() + i * 60000,
        open: price,
        high: price + 5,
        low: price - 5,
        close: price + (Math.random() * 2 - 1),
        volume: 100 + Math.random() * 50
      });
      price = candles[candles.length - 1].close;
    }

    const snapshot: MarketSnapshot = {
      symbol: 'BTCUSDT',
      timestamp: Date.now(),
      currentPrice: price,
      volume24h: 10000,
      quoteVolume24h: 1000000,
      candles: {
        '15m': candles
      } as Record<Timeframe, NormalizedCandle[]>,
      metadata: {
        priceChange24h: 0,
        priceChangePercent24h: 0,
        highPrice24h: 120,
        lowPrice24h: 90
      }
    };

    const result = engine.evaluate(snapshot);

    expect(result.timestamp).toBe(snapshot.timestamp);
    expect(result.timeframes['15m']).toBeDefined();

    const tfInds = result.timeframes['15m'];

    // Check RSI
    expect(tfInds.rsi[14]).toBeDefined();
    expect(tfInds.rsi[14].length).toBe(100);
    expect(tfInds.rsi[14][0]).toBeNaN(); // Period not reached
    expect(tfInds.rsi[14][99]).not.toBeNaN();

    // Check SMA
    expect(tfInds.sma[20]).toBeDefined();
    expect(tfInds.sma[20].length).toBe(100);
    expect(tfInds.sma[20][18]).toBeNaN();
    expect(tfInds.sma[20][19]).not.toBeNaN();

    // Check EMA
    expect(tfInds.ema[50]).toBeDefined();
    expect(tfInds.ema[50].length).toBe(100);
    expect(tfInds.ema[50][48]).toBeNaN();
    expect(tfInds.ema[50][49]).not.toBeNaN();
    expect(tfInds.ema[50][99]).not.toBeNaN();

    // Check MACD
    expect(tfInds.macd['12,26,9']).toBeDefined();
    expect(tfInds.macd['12,26,9'].length).toBe(100);
    expect(tfInds.macd['12,26,9'][25].macdLine).not.toBeNaN(); // Slow period is 26, so index 25
    expect(tfInds.macd['12,26,9'][99].macdLine).not.toBeNaN();
    // Signal line needs MACD line (26) + signal period (9) = 34 candles
    expect(tfInds.macd['12,26,9'][33].signalLine).not.toBeNaN();

    // Check ATR
    expect(tfInds.atr[14]).toBeDefined();
    expect(tfInds.atr[14].length).toBe(100);
    expect(tfInds.atr[14][13]).toBeNaN();
    expect(tfInds.atr[14][14]).not.toBeNaN();

    // Check Volume
    expect(tfInds.volume.length).toBe(100);
    expect(tfInds.volume[18].averageVolume).toBeNaN();
    expect(tfInds.volume[19].averageVolume).not.toBeNaN();
    expect(tfInds.volume[1].volumeChangePercent).not.toBeNaN();
  });
});
