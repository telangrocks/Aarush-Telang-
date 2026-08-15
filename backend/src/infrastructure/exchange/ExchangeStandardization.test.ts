import { describe, it, expect } from 'vitest';
import { BybitAdapter } from './adapters/BybitAdapter';

describe('Exchange Adapters Standardization Unit Tests', () => {
  const adapters = [
    { name: 'Bybit', instance: new BybitAdapter() },
  ];

  it('normalizes various input symbol formats to canonical BASE/QUOTE', () => {
    for (const { instance } of adapters) {
      expect(instance.normalizeSymbol('BTC/USDT').canonicalSymbol).toBe('BTC/USDT');
      expect(instance.normalizeSymbol('BTCUSDT').canonicalSymbol).toBe('BTC/USDT');
      expect(instance.normalizeSymbol('BTC-USDT').canonicalSymbol).toBe('BTC/USDT');
      expect(instance.normalizeSymbol('SOL_USDC').canonicalSymbol).toBe('SOL/USDC');
    }
  });

  it('exposes correct capability declarations for Bybit', () => {
    const bybit = new BybitAdapter();
    expect(bybit.capabilities.supportsOco).toBe(false);
    expect(bybit.capabilities.supportsFutures).toBe(true);
  });
});
