import { describe, it, expect } from 'vitest';
import { BinanceAdapter } from './adapters/BinanceAdapter';
import { KucoinAdapter } from './adapters/KucoinAdapter';
import { BybitAdapter } from './adapters/BybitAdapter';

describe('Exchange Adapters Standardization Unit Tests', () => {
  const adapters = [
    { name: 'Binance', instance: new BinanceAdapter() },
    { name: 'KuCoin', instance: new KucoinAdapter() },
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

  it('exposes correct capability declarations for each exchange', () => {
    const binance = new BinanceAdapter();
    expect(binance.capabilities.supportsOco).toBe(true);
    expect(binance.capabilities.requiresPassphrase).toBe(false);

    const kucoin = new KucoinAdapter();
    expect(kucoin.capabilities.supportsOco).toBe(false);
    expect(kucoin.capabilities.requiresPassphrase).toBe(true);

    const bybit = new BybitAdapter();
    expect(bybit.capabilities.supportsOco).toBe(false);
    expect(bybit.capabilities.supportsFutures).toBe(true);
  });
});
