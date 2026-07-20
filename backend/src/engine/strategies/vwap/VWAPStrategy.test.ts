import { describe, it, expect } from 'vitest';
import { VWAPStrategy } from './VWAPStrategy';
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
});
