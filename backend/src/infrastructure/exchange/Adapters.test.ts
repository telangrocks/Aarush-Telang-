import { describe, it, expect, beforeEach } from 'vitest';
import { ExchangeRegistry } from './registry/ExchangeRegistry';
import { BinanceAdapter } from './adapters/BinanceAdapter';
import { KucoinAdapter } from './adapters/KucoinAdapter';
import { BybitAdapter } from './adapters/BybitAdapter';

describe('Exchange Adapters & Dynamic Self-Registration Registry Unit Tests', () => {
  beforeEach(() => {
    ExchangeRegistry.clear();
    ExchangeRegistry.register({ exchangeId: 'binance', factory: () => new BinanceAdapter() });
    ExchangeRegistry.register({ exchangeId: 'kucoin', factory: () => new KucoinAdapter() });
    ExchangeRegistry.register({ exchangeId: 'bybit', factory: () => new BybitAdapter() });
  });

  it('ExchangeRegistry registers and instantiates adapters without branching', () => {
    expect(ExchangeRegistry.has('binance')).toBe(true);
    expect(ExchangeRegistry.has('kucoin')).toBe(true);
    expect(ExchangeRegistry.has('bybit')).toBe(true);
    expect(ExchangeRegistry.has('unknown')).toBe(false);

    const binance = ExchangeRegistry.create('binance');
    expect(binance).toBeInstanceOf(BinanceAdapter);
    expect(binance.capabilities.supportsOco).toBe(true);

    const kucoin = ExchangeRegistry.create('kucoin');
    expect(kucoin).toBeInstanceOf(KucoinAdapter);
    expect(kucoin.capabilities.requiresPassphrase).toBe(true);
  });

  it('BinanceAdapter rejects missing credentials', async () => {
    const binance = new BinanceAdapter();
    await binance.connect({ environment: 'testnet' });
    await expect(binance.fetchBalance()).rejects.toThrow('Missing required exchange credentials');
  });

  it('KucoinAdapter rejects sandbox mode as deprecated', async () => {
    const kucoin = new KucoinAdapter();
    await expect(kucoin.connect({ environment: 'testnet' })).rejects.toThrow('KuCoin Sandbox is officially deprecated');
  });
});
