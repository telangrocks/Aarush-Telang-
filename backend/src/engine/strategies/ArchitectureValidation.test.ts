import { describe, it, expect } from 'vitest';
import { StrategyRegistry } from './StrategyRegistry';
import { StrategyContext } from '../context/StrategyContext';
import { MarketSnapshot } from '../market-data/MarketSnapshot';

describe('Architecture v2.0 Plugin Validation', () => {
  it('should evaluate multiple independent strategies against the same MarketSnapshot', () => {
    const registry = StrategyRegistry.getInstance();
    const scalper = registry.getStrategy('ScalperV2');
    const momentum = registry.getStrategy('Momentum');

    expect(scalper).toBeDefined();
    expect(momentum).toBeDefined();

    // Create a market snapshot that strongly triggers Scalper but might be weak/neutral for Momentum
    const snapshot: MarketSnapshot = {
      symbol: 'SOL/USDT',
      timestamp: Date.now(),
      currentPrice: 150,
      volume24h: 100000,
      quoteVolume24h: 15000000,
      metadata: { priceChange24h: 5, priceChangePercent24h: 3.3, highPrice24h: 155, lowPrice24h: 140 },
      candles: {
        '5m': [
          { timestamp: 1, open: 140, high: 145, low: 135, close: 140, volume: 1000 },
          { timestamp: 2, open: 140, high: 145, low: 135, close: 145, volume: 1100 },
          { timestamp: 3, open: 145, high: 155, low: 145, close: 150, volume: 2000 } // Strong 5m breakout
        ],
        '1h': [
          { timestamp: 1, open: 149, high: 151, low: 148, close: 149, volume: 100 },
          { timestamp: 2, open: 149, high: 151, low: 148, close: 149, volume: 100 },
          { timestamp: 3, open: 149, high: 151, low: 148, close: 150, volume: 100 } // Flat 1h
        ]
      } as any
    };

    const context = new StrategyContext(snapshot).freeze();

    // Evaluate Scalper
    const scalperResult = scalper!.evaluate(context);
    expect(scalperResult.strategyId).toBe('scalper-v2');
    expect(scalperResult.hasSignal).toBeDefined();

    // Evaluate Momentum
    const momentumResult = momentum!.evaluate(context);
    expect(momentumResult.strategyId).toBe('Momentum');
    expect(momentumResult.hasSignal).toBeDefined();

    // They must produce independent evaluations without affecting the frozen engine state
    expect(scalperResult.metadata.signal).toBeDefined();
    expect(momentumResult.metadata.signal).toBeDefined();
    
    // The two results should be isolated instances
    expect(scalperResult).not.toEqual(momentumResult);
  });
});
