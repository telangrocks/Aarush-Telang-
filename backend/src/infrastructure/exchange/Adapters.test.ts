import { describe, it, expect, beforeEach } from 'vitest';
import { ExchangeRegistry } from './registry/ExchangeRegistry';
import { BybitAdapter } from './adapters/BybitAdapter';

describe('Exchange Adapters & Dynamic Self-Registration Registry Unit Tests', () => {
  beforeEach(() => {
    ExchangeRegistry.clear();
    ExchangeRegistry.register({ exchangeId: 'bybit', factory: () => new BybitAdapter() });
  });

  it('ExchangeRegistry registers and instantiates BybitAdapter without branching', () => {
    expect(ExchangeRegistry.has('bybit')).toBe(true);
    expect(ExchangeRegistry.has('binance')).toBe(false);
    expect(ExchangeRegistry.has('kucoin')).toBe(false);
    expect(ExchangeRegistry.has('unknown')).toBe(false);

    const bybit = ExchangeRegistry.create('bybit');
    expect(bybit).toBeInstanceOf(BybitAdapter);
    expect(bybit.capabilities.supportsFutures).toBe(true);
  });

  it('BybitAdapter rejects missing credentials', async () => {
    const bybit = new BybitAdapter();
    await bybit.connect({ environment: 'demo' });
    await expect(bybit.fetchBalance()).rejects.toThrow('Missing required exchange credentials');
  });
});
