import { describe, it, expect } from 'vitest';
import { BreakoutStrategy } from './BreakoutStrategy';
import { StrategyContext } from '../../context/StrategyContext';
import { Timeframe } from '../../market-data/Timeframe';

describe('BreakoutStrategy', () => {
  it('should initialize and evaluate returning no signal when data is insufficient', () => {
    const strategy = new BreakoutStrategy();
    expect(strategy.manifest.id).toBe('Breakout');
    expect(strategy.manifest.category).toBe('Breakout');

    const emptyContext = new StrategyContext({
      symbol: 'BTC/USDT',
      timestamp: Date.now(),
      currentPrice: 50000,
      volume24h: 1000,
      quoteVolume24h: 1000,
      metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 0, lowPrice24h: 0 },
      candles: {
        '15m': []
      } as any
    }).freeze();

    const result = strategy.evaluate(emptyContext);
    expect(result.strategyId).toBe('Breakout');
    expect(result.hasSignal).toBe(false); // Because there are no candles, logic falls through to HOLD/false
  });
});
