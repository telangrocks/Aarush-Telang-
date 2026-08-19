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

  it('Test K: BybitAdapter rejects clientOrderId > 36 characters instead of silent truncation', async () => {
    const config: any = {
      apiKey: 'test-key',
      secret: 'test-secret',
      environment: 'testnet'
    };
    const adapter = new BybitAdapter();
    await adapter.connect(config);

    const overLimitId = '1234567890123456789012345678901234567'; // 37 characters
    const BigNumber = require('bignumber.js');

    await expect(adapter.createOrder({
      symbol: 'BTC/USDT',
      type: 'market',
      side: 'buy',
      amount: new BigNumber(1),
      clientOrderId: overLimitId
    })).rejects.toThrow(/exceeds 36 characters/);
  });
});
