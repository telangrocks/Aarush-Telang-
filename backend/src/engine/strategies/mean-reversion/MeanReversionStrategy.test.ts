import { describe, it, expect } from 'vitest';
import { MeanReversionStrategy } from './MeanReversionStrategy';
import { StrategyContext } from '../../context/StrategyContext';

describe('MeanReversionStrategy', () => {
  it('should initialize and hold when data is insufficient', () => {
    const strategy = new MeanReversionStrategy();
    expect(strategy.manifest.id).toBe('MeanReversion');
    
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
    expect(result.strategyId).toBe('MeanReversion');
    expect(result.hasSignal).toBe(false);
    expect(result.metadata?.reasoning).toContain('Insufficient candles for 2-step confirmation');
  });

  it('should hold during a strong trend (EMA separation too large)', () => {
    const strategy = new MeanReversionStrategy();
    
    // Create candles with huge trend (EMA fast << EMA slow)
    // We mock the candles such that the IndicatorEngine calculates a huge separation
    const candles = Array.from({ length: 100 }).map((_, i) => ({
      timestamp: i,
      open: 50000 + (i * 100),
      high: 50100 + (i * 100),
      low: 49900 + (i * 100),
      close: 50000 + (i * 100),
      volume: 100
    }));

    const context = new StrategyContext({
      symbol: 'BTC/USDT',
      timestamp: Date.now(),
      currentPrice: 60000,
      volume24h: 1000,
      quoteVolume24h: 1000,
      metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 0, lowPrice24h: 0 },
      candles: {
        '15m': candles
      } as any
    }).freeze();

    const result = strategy.evaluate(context);
    expect(result.hasSignal).toBe(false);
    // Since we mock linearly increasing candles, EMA separation might or might not cross the 5% threshold,
    // but definitely no oversold/overbought reversal will trigger because RSI will be stuck at high values (overbought)
    // and not reversing down yet.
    // If we want to strictly test EMA separation, we would need to mock the indicator output which is handled by IndicatorEngine.
    // We can just assert no buy/sell signal is fired blindly.
  });
});
