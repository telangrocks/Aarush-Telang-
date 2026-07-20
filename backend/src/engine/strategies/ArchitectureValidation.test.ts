import { describe, it, expect } from 'vitest';
import { StrategyRegistry } from './StrategyRegistry';
import { StrategyContext } from '../context/StrategyContext';
import { MarketSnapshot } from '../market-data/MarketSnapshot';

describe('Architecture v2.1 Plugin Validation', () => {
  it('should evaluate multiple independent strategies against the same MarketSnapshot', () => {
    const registry = StrategyRegistry.getInstance();
    const scalper = registry.getStrategy('ScalperV2');
    const momentum = registry.getStrategy('Momentum');
    const breakout = registry.getStrategy('Breakout');
    const meanReversion = registry.getStrategy('MeanReversion');

    expect(scalper).toBeDefined();
    expect(momentum).toBeDefined();
    expect(breakout).toBeDefined();
    expect(meanReversion).toBeDefined();

    // Create a market snapshot
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
          { timestamp: 3, open: 145, high: 155, low: 145, close: 150, volume: 2000 }
        ],
        '15m': [
          { timestamp: 1, open: 140, high: 145, low: 135, close: 140, volume: 1000 },
          { timestamp: 2, open: 140, high: 145, low: 135, close: 145, volume: 1100 },
          { timestamp: 3, open: 145, high: 155, low: 145, close: 150, volume: 2000 }
        ],
        '1h': [
          { timestamp: 1, open: 149, high: 151, low: 148, close: 149, volume: 100 },
          { timestamp: 2, open: 149, high: 151, low: 148, close: 149, volume: 100 },
          { timestamp: 3, open: 149, high: 151, low: 148, close: 150, volume: 100 }
        ]
      } as any
    };

    const context = new StrategyContext(snapshot).freeze();

    // Evaluate Scalper
    const scalperResult = scalper!.evaluate(context);
    expect(scalperResult.strategyId).toBe('ScalperV2');
    expect(scalperResult.hasSignal).toBeDefined();

    // Evaluate Momentum
    const momentumResult = momentum!.evaluate(context);
    expect(momentumResult.strategyId).toBe('Momentum');
    expect(momentumResult.hasSignal).toBeDefined();

    // Evaluate Breakout
    const breakoutResult = breakout!.evaluate(context);
    expect(breakoutResult.strategyId).toBe('Breakout');
    expect(breakoutResult.hasSignal).toBeDefined();

    // Evaluate MeanReversion
    const meanReversionResult = meanReversion!.evaluate(context);
    expect(meanReversionResult.strategyId).toBe('MeanReversion');
    expect(meanReversionResult.hasSignal).toBeDefined();

    // They must produce independent evaluations without affecting the frozen engine state
    expect(scalperResult.metadata.signal).toBeDefined();
    expect(momentumResult.metadata.signal).toBeDefined();
    expect(breakoutResult.metadata.signal).toBeDefined();
    
    // MeanReversion will return HOLD and early abort due to logic (not 2 candles), or it may run.
    // Ensure independence
    expect(scalperResult).not.toEqual(momentumResult);
    expect(momentumResult).not.toEqual(breakoutResult);
    expect(breakoutResult).not.toEqual(meanReversionResult);
  });
});

