import { describe, it, expect, vi } from 'vitest';
import { AdapterCandleProvider } from './AdapterCandleProvider';
import { IExchangeAdapter } from '../../infrastructure/exchange/types';
import { UnifiedError } from '../../exchanges/models/UnifiedError';

describe('AdapterCandleProvider Unit Tests', () => {
  const mockAdapter: IExchangeAdapter = {
    exchangeId: 'binance',
    capabilities: {} as any,
    connect: vi.fn(),
    disconnect: vi.fn(),
    fetchMarkets: vi.fn(),
    fetchBalance: vi.fn(),
    fetchTicker: vi.fn().mockResolvedValue({
      symbol: 'BTC/USDT',
      timestamp: Date.now(),
      last: { toNumber: () => 60000 },
    } as any),
    fetchKlines: vi.fn().mockResolvedValue([
      { openTime: 1600000000000, open: 100, high: 105, low: 98, close: 102, volume: 50 },
    ]),
    fetchPositions: vi.fn(),
    createOrder: vi.fn(),
    cancelOrder: vi.fn(),
    fetchOrder: vi.fn(),
    fetchOpenOrders: vi.fn(),
    fetchClosedOrders: vi.fn(),
    fetchMyTrades: vi.fn(),
  };

  it('preserves openTime field name on mapped candles (Fix C1)', async () => {
    const provider = new AdapterCandleProvider(mockAdapter);
    const candles = await provider.fetchCandles('BTC/USDT', '15m');

    expect(candles.length).toBe(1);
    expect(candles[0].openTime).toBe(1600000000000);
    expect(typeof candles[0].openTime).toBe('number');
  });

  it('retries on retryable UnifiedError and succeeds (Fix H4)', async () => {
    let calls = 0;
    const retryAdapter = {
      ...mockAdapter,
      fetchKlines: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          throw new UnifiedError('Request timed out after 10000ms.', 'EXCHANGE_TIMEOUT');
        }
        return [{ openTime: 1600000000000, open: 100, high: 105, low: 98, close: 102, volume: 50 }];
      }),
    };

    const provider = new AdapterCandleProvider(retryAdapter);
    const candles = await provider.fetchCandles('BTC/USDT', '15m');

    expect(calls).toBe(2);
    expect(candles.length).toBe(1);
  });

  it('does not retry non-retryable error (e.g. MISSING_REQUIRED_CREDENTIALS)', async () => {
    let calls = 0;
    const failAdapter = {
      ...mockAdapter,
      fetchKlines: vi.fn().mockImplementation(async () => {
        calls++;
        throw new UnifiedError('Missing credentials', 'MISSING_REQUIRED_CREDENTIALS');
      }),
    };

    const provider = new AdapterCandleProvider(failAdapter);
    await expect(provider.fetchCandles('BTC/USDT', '15m')).rejects.toThrow('Missing credentials');
    expect(calls).toBe(1);
  });
});
