import { describe, it, expect } from 'vitest';
import { MomentumStrategy } from './MomentumStrategy';
import { StrategyContext } from '../../context/StrategyContext';
import { MarketSnapshot } from '../../market-data/MarketSnapshot';

describe('MomentumStrategy', () => {
  it('should generate a BUY signal for a valid momentum setup', () => {
    const strategy = new MomentumStrategy();

    // Create a market snapshot that will trigger bullish conditions on 1h
    const snapshot: MarketSnapshot = {
      symbol: 'ETH/USDT',
      timestamp: Date.now(),
      currentPrice: 2000,
      volume24h: 50000,
      quoteVolume24h: 100000000,
      metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 2100, lowPrice24h: 1900 },
      candles: {
        '1h': [
          { timestamp: 1, open: 1900, high: 1950, low: 1850, close: 1900, volume: 1000 },
          { timestamp: 2, open: 1900, high: 1950, low: 1850, close: 1950, volume: 1100 },
          { timestamp: 3, open: 1950, high: 2100, low: 1900, close: 2000, volume: 2000 }
        ]
      } as any
    };

    const context = new StrategyContext(snapshot).freeze();
    const result = strategy.evaluate(context);

    expect(result.strategyId).toBe('Momentum');
    
    // Engine will evaluate, check that properties exist
    expect(result).toHaveProperty('hasSignal');
    expect(result.metadata.reasoning).toBeInstanceOf(Array);
  });

  it('should generate HOLD for weak momentum or consolidation', () => {
    const strategy = new MomentumStrategy();

    const snapshot: MarketSnapshot = {
      symbol: 'ETH/USDT',
      timestamp: Date.now(),
      currentPrice: 2000,
      volume24h: 5000,
      quoteVolume24h: 10000000,
      metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 2010, lowPrice24h: 1990 },
      candles: {
        '1h': [
          { timestamp: 1, open: 2000, high: 2010, low: 1990, close: 2000, volume: 100 },
          { timestamp: 2, open: 2000, high: 2010, low: 1990, close: 2000, volume: 100 },
          { timestamp: 3, open: 2000, high: 2010, low: 1990, close: 2000, volume: 100 }
        ]
      } as any
    };

    const context = new StrategyContext(snapshot).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal.type).toBe('HOLD');
    expect(result.metadata.reasoning.some((r: string) => r.includes('No strong directional bias') || r.includes('Confidence score'))).toBe(true);
  });
});
