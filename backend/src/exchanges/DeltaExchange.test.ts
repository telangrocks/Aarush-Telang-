import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeltaExchange } from './DeltaExchange';

describe('DeltaExchange Adapter Order & Leverage Enforcement', () => {
  let mockFetch: any;

  beforeEach(() => {
    mockFetch = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should explicitly set leverage to 1x before placing a market order', async () => {
    const adapter = new DeltaExchange();
    adapter.setEnvironment('testnet');
    adapter.setRegion('india');

    // 1. Mock fetch responses:
    // First, for getSymbolMetadata (it needs to load the metadata cache from products)
    // Second, for changing leverage (POST /v2/products/123/orders/leverage)
    // Third, for placing the order (POST /v2/orders)
    mockFetch.mockImplementation(async (url: string, init?: any) => {
      if (url.includes('/v2/products')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: [
              {
                id: 123,
                symbol: 'BTCUSD',
                min_notional_value: '0.0001',
                max_notional_value: '1000',
                lot_size: '0.0001',
                tick_size: '0.01',
                contract_type: 'perpetual_futures',
              }
            ]
          })
        } as Response;
      }

      if (url.includes('/v2/products/123/orders/leverage')) {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(init.body);
        expect(body.leverage).toBe('1');
        return {
          ok: true,
          json: async () => ({ success: true, result: { leverage: '1' } })
        } as Response;
      }

      if (url.includes('/v2/orders')) {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(init.body);
        expect(body.symbol).toBe('BTCUSD');
        expect(body.side).toBe('buy');
        expect(body.type).toBe('market');
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: {
              id: 'order-123',
              avg_price: '60000',
              quantity: '0.01'
            }
          })
        } as Response;
      }

      return { ok: true, json: async () => ({ success: true, result: [] }) } as Response;
    });

    // Warm up metadata cache
    await (adapter as any).fetchExchangeMetadata().then((map: any) => {
      (adapter as any).metadataCache = map;
      (adapter as any).lastCacheFetch = Date.now();
    });

    // Execute order placement
    const res = await adapter.placeOrder('BTC', 'BUY', 'fake-key', 'fake-secret', 0.01);

    // Verify order placement succeeded
    expect(res.success).toBe(true);
    expect(res.orderId).toBe('order-123');

    // Confirm both endpoints were hit
    const calledUrls = mockFetch.mock.calls.map((call: any) => call[0]);
    expect(calledUrls.some((u: string) => u.includes('/v2/products/123/orders/leverage'))).toBe(true);
    expect(calledUrls.some((u: string) => u.includes('/v2/orders'))).toBe(true);
  });
});
