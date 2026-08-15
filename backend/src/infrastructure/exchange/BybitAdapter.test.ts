import { describe, it, expect, beforeEach } from 'vitest';
import { BybitAdapter } from './adapters/BybitAdapter';

describe('BybitAdapter V5 Unit Tests', () => {
  let adapter: BybitAdapter;

  beforeEach(() => {
    adapter = new BybitAdapter();
  });

  it('selects correct environment hosts for mainnet and demo', async () => {
    await adapter.connect({ environment: 'mainnet' });
    expect(adapter.getHost()).toBe('https://api.bybit.com');

    await adapter.connect({ environment: 'demo' });
    expect(adapter.getHost()).toBe('https://api-demo.bybit.com');
  });

  it('normalizes symbols consistently', () => {
    expect(adapter.normalizeSymbol('BTC/USDT').canonicalSymbol).toBe('BTC/USDT');
    expect(adapter.normalizeSymbol('BTCUSDT').canonicalSymbol).toBe('BTC/USDT');
    expect(adapter.normalizeSymbol('BTC-USDT').canonicalSymbol).toBe('BTC/USDT');
    expect(adapter.normalizeSymbol('ETH_USDT').canonicalSymbol).toBe('ETH/USDT');
  });

  it('rejects private requests when API credentials are missing', async () => {
    await adapter.connect({ environment: 'demo' });
    await expect(adapter.fetchBalance()).rejects.toThrow('Missing required exchange credentials');
  });

  it('keeps supportsOco as false for linear position protection', () => {
    expect(adapter.capabilities.supportsOco).toBe(false);
  });

  it('builds createOrder payload with category=linear and serializes TP/SL', async () => {
    await adapter.connect({ environment: 'demo', apiKey: 'testKey', secret: 'testSecret' });

    let capturedParams: any = null;
    (adapter as any).makeRequest = async (method: string, path: string, params: any) => {
      capturedParams = params;
      return { orderId: 'test_order_123', orderLinkId: params.orderLinkId };
    };

    const orderReq = {
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      amount: new (require('bignumber.js'))(0.0015),
      clientOrderId: 'alert_test_123',
      takeProfit: 67000.5,
      stopLoss: 63000.25,
    } as any;

    const res = await adapter.createOrder(orderReq);

    expect(res.id).toBe('test_order_123');
    expect(capturedParams.category).toBe('linear');
    expect(capturedParams.symbol).toBe('BTCUSDT');
    expect(capturedParams.side).toBe('Buy');
    expect(capturedParams.orderType).toBe('Market');
    expect(capturedParams.takeProfit).toBe('67000.5');
    expect(capturedParams.stopLoss).toBe('63000.25');
  });
});
