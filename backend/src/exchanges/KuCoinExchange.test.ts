import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KuCoinExchange } from './KuCoinExchange';

describe('KuCoinExchange', () => {
  let exchange: KuCoinExchange;

  beforeEach(() => {
    exchange = new KuCoinExchange('testnet', 'global');
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with correct config', () => {
    expect(exchange.getName()).toBe('kucoin');
    expect(exchange.getRestUrl()).toBe('https://openapi-sandbox.kucoin.com');
  });

  it('should validate valid credentials correctly', async () => {
    const mockResponse = {
      code: '200000',
      data: [{ currency: 'BTC', balance: '1.5' }]
    };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    });

    const result = await exchange.validateCredentials('key', 'secret', 'passphrase');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.message).toContain('successfully');
    }
  });

  it('should handle invalid credentials (400001)', async () => {
    const mockResponse = {
      code: '400001',
      msg: 'Invalid API Key'
    };
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    });

    const result = await exchange.validateCredentials('key', 'secret', 'passphrase');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('INVALID_API_KEY');
    }
  });

  it('should handle invalid signature (400100)', async () => {
    const mockResponse = {
      code: '400100',
      msg: 'Invalid API Sign'
    };
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    });

    const result = await exchange.validateCredentials('key', 'secret', 'passphrase');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('INVALID_SIGNATURE');
    }
  });

  it('should handle missing passphrase (400004)', async () => {
    const mockResponse = {
      code: '400004',
      msg: 'Invalid Passphrase'
    };
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    });

    const result = await exchange.validateCredentials('key', 'secret', 'passphrase');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('INVALID_PASSPHRASE');
    }
  });

  it('should format market data correctly', async () => {
    const mockResponse = {
      code: '200000',
      data: {
        ticker: [
          { symbol: 'BTC-USDT', last: '50000', changeRate: '0.05', vol: '100', volValue: '5000000', high: '51000', low: '49000' }
        ]
      }
    };
    const mockMetaResponse = {
      code: '200000',
      data: [{
        symbol: 'BTC-USDT',
        enableTrading: true,
        baseMinSize: '0.001',
        baseMaxSize: '1000',
        baseIncrement: '0.001',
        priceIncrement: '0.1',
        minFunds: '10'
      }]
    };
    (global.fetch as any).mockImplementation((url: string) => {
      if (url.includes('/api/v2/symbols')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockMetaResponse)
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });
    });

    const tickers = await exchange.fetchMarketData();
    expect(tickers).toHaveLength(1);
    expect(tickers[0].symbol).toBe('BTC');
    expect(tickers[0].price).toBe(50000);
    expect(tickers[0].priceChangePercent24h).toBe(5); // 0.05 * 100
  });

  it('should place a market order successfully', async () => {
    // Mock metadata
    const mockMetaResponse = {
      code: '200000',
      data: [{
        symbol: 'BTC-USDT',
        enableTrading: true,
        baseMinSize: '0.001',
        baseMaxSize: '1000',
        baseIncrement: '0.001',
        priceIncrement: '0.1',
        minFunds: '10'
      }]
    };
    // Mock place order response
    const mockOrderResponse = {
      code: '200000',
      data: { orderId: 'kucoin-order-id-123' }
    };
    
    (global.fetch as any).mockImplementation((url: string) => {
      if (url.includes('/api/v2/symbols')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockMetaResponse)
        });
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(mockOrderResponse))
      });
    });

    const result = await exchange.placeOrder('BTC-USDT', 'BUY', 'key', 'secret', 0.1, 'client-oid-1', 'MARKET', undefined, undefined, undefined, 'pass');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.exchangeOrderId).toBe('kucoin-order-id-123');
      expect(result.orderId).toBe('client-oid-1');
    }
  });

  it('should place an OCO order successfully', async () => {
    // Mock metadata
    const mockMetaResponse = {
      code: '200000',
      data: [{
        symbol: 'BTC-USDT',
        enableTrading: true,
        baseMinSize: '0.001',
        baseMaxSize: '1000',
        baseIncrement: '0.001',
        priceIncrement: '0.1',
        minFunds: '10'
      }]
    };
    // Mock OCO order response
    const mockOrderResponse = {
      code: '200000',
      data: { orderId: 'kucoin-oco-123' }
    };
    
    (global.fetch as any).mockImplementation((url: string) => {
      if (url.includes('/api/v2/symbols')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockMetaResponse)
        });
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(mockOrderResponse))
      });
    });

    const result = await exchange.placeOcoOrder('BTC-USDT', 'SELL', 'key', 'secret', 0.5, 60000, 40000, 'oco-client-oid-1', 'pass');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.exchangeOrderId).toBe('kucoin-oco-123');
      expect(result.protectionMode).toBe('NATIVE_OCO');
    }
  });

  it('should handle circuit breaker when rate limits are hit', async () => {
    const mockResponse = {
      code: '429000',
      msg: 'Too Many Requests'
    };
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    });

    // Make 5 requests to trip breaker
    for (let i = 0; i < 5; i++) {
      await exchange.fetchBalances('key', 'secret', 'passphrase');
    }

    // 6th request should fail fast due to circuit breaker
    const result = await exchange.fetchBalances('key', 'secret', 'passphrase');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain('Circuit breaker is OPEN');
    }
  });

  it('should fetch and map balances correctly', async () => {
    const mockResponse = {
      code: '200000',
      data: [
        { currency: 'BTC', balance: '1.5', available: '1.0', holds: '0.5' },
        { currency: 'USDT', balance: '1000', available: '1000', holds: '0' }
      ]
    };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(mockResponse)),
    });

    const result = await exchange.fetchBalances('key', 'secret', 'passphrase');
    expect(result.success).toBe(true);
    if (result.success && result.balances) {
      expect(result.balances).toHaveLength(2);
      expect(result.balances.find(b => b.asset === 'BTC')?.free).toBe(1.0);
      expect(result.balances.find(b => b.asset === 'BTC')?.locked).toBe(0.5);
    }
  });

});
