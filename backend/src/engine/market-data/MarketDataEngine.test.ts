import { describe, it, expect, vi } from 'vitest';
import { MarketDataEngine } from './MarketDataEngine';
import { ICandleProvider } from '../../infrastructure/exchange/types';
import { Timeframe } from './Timeframe';

describe('MarketDataEngine', () => {
  const mockTicker = {
    symbol: 'BTCUSDT',
    last: 60000,
    volume: 1000,
    quoteVolume: 60000000,
    high: 61000,
    low: 59000,
    bid: 59990,
    ask: 60010,
    timestamp: Date.now(),
  };

  const mockCandle = {
    openTime: Date.now() - 60000,
    timestamp: Date.now() - 60000,
    open: 60000,
    high: 60100,
    low: 59900,
    close: 60050,
    volume: 10,
  };

  const mockProvider: ICandleProvider = {
    fetchTicker: vi.fn().mockResolvedValue(mockTicker),
    fetchCandles: vi.fn().mockResolvedValue([mockCandle, { ...mockCandle, openTime: Date.now() }]),
  };

  it('should fetch snapshot with requested timeframes', async () => {
    const engine = new MarketDataEngine(mockProvider);

    const timeframes: Timeframe[] = ['15m', '1h'];
    const snapshot = await engine.getSnapshot('BTCUSDT', timeframes);

    expect(mockProvider.fetchTicker).toHaveBeenCalledWith('BTCUSDT');
    expect(mockProvider.fetchCandles).toHaveBeenCalledWith('BTCUSDT', '15m', 200);
    expect(mockProvider.fetchCandles).toHaveBeenCalledWith('BTCUSDT', '1h', 200);

    expect(snapshot.symbol).toBe('BTCUSDT');
    expect(snapshot.currentPrice).toBe(60000);
    expect(snapshot.candles['15m'].length).toBe(2);
    expect(snapshot.candles['1h'].length).toBe(2);
    expect(snapshot.metadata.highPrice24h).toBe(61000);
  });

  it('should handle partial timeframe failure using Promise.allSettled (Fix M1)', async () => {
    const partialProvider: ICandleProvider = {
      fetchTicker: vi.fn().mockResolvedValue(mockTicker),
      fetchCandles: vi.fn().mockImplementation(async (_symbol: string, tf: string) => {
        if (tf === '1h') throw new Error('1h timeframe API timeout');
        return [mockCandle];
      }),
    };

    const engine = new MarketDataEngine(partialProvider);
    const snapshot = await engine.getSnapshot('BTCUSDT', ['15m', '1h']);

    expect(snapshot.candles['15m'].length).toBe(1);
    expect(snapshot.candles['1h']).toEqual([]);
  });

  it('should throw when all timeframes fail', async () => {
    const failingProvider: ICandleProvider = {
      fetchTicker: vi.fn().mockResolvedValue(mockTicker),
      fetchCandles: vi.fn().mockRejectedValue(new Error('Network error')),
    };

    const engine = new MarketDataEngine(failingProvider);
    await expect(engine.getSnapshot('BTCUSDT', ['15m', '1h'])).rejects.toThrow(
      'All timeframes failed for BTCUSDT'
    );
  });

  it('should throw an error if no timeframes provided', async () => {
    const engine = new MarketDataEngine(mockProvider);
    await expect(engine.getSnapshot('BTCUSDT', [])).rejects.toThrow('At least one timeframe must be specified');
  });

  it('should throw an error if ticker fetch fails', async () => {
    const brokenProvider: ICandleProvider = {
      fetchTicker: vi.fn().mockResolvedValue(null),
      fetchCandles: vi.fn().mockResolvedValue([]),
    };
    const engine = new MarketDataEngine(brokenProvider);
    await expect(engine.getSnapshot('BTCUSDT', ['5m'])).rejects.toThrow('Failed to fetch market ticker for symbol: BTCUSDT');
  });
});
