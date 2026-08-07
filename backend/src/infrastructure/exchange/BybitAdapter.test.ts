import { describe, it, expect, beforeEach } from 'vitest';
import { BybitAdapter } from './adapters/BybitAdapter';

describe('BybitAdapter V5 Unit Tests', () => {
  let adapter: BybitAdapter;

  beforeEach(() => {
    adapter = new BybitAdapter();
  });

  it('selects correct environment hosts for mainnet and testnet', async () => {
    await adapter.connect({ environment: 'mainnet' });
    expect(adapter.getHost()).toBe('https://api.bybit.com');

    await adapter.connect({ environment: 'testnet' });
    expect(adapter.getHost()).toBe('https://api-testnet.bybit.com');

    await adapter.connect({ environment: 'sandbox' });
    expect(adapter.getHost()).toBe('https://api-testnet.bybit.com');
  });

  it('normalizes symbols consistently', () => {
    expect(adapter.normalizeSymbol('BTC/USDT').canonicalSymbol).toBe('BTC/USDT');
    expect(adapter.normalizeSymbol('BTCUSDT').canonicalSymbol).toBe('BTC/USDT');
    expect(adapter.normalizeSymbol('BTC-USDT').canonicalSymbol).toBe('BTC/USDT');
    expect(adapter.normalizeSymbol('ETH_USDT').canonicalSymbol).toBe('ETH/USDT');
  });

  it('rejects private requests when API credentials are missing', async () => {
    await adapter.connect({ environment: 'testnet' });
    await expect(adapter.fetchBalance()).rejects.toThrow('Missing required exchange credentials');
  });
});
