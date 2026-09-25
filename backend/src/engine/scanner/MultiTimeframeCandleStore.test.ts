import { describe, it, expect, vi } from 'vitest';
import { MultiTimeframeCandleStore, ScannerTimeframe } from './MultiTimeframeCandleStore';
import { ICandleProvider } from '../../infrastructure/exchange/types';
import { CandleValidator } from '../../infrastructure/exchange/CandleValidator';

function generateFreshCandles(timeframe: ScannerTimeframe, count: number = 50) {
  const tfMs = CandleValidator.timeframeToMs(timeframe);
  const now = Date.now();
  const startTime = now - count * tfMs;

  return Array.from({ length: count }, (_, i) => ({
    timestamp: startTime + i * tfMs,
    openTime: startTime + i * tfMs,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 102 + i,
    volume: 1000,
  }));
}

describe('MultiTimeframeCandleStore', () => {
  const mockProvider: ICandleProvider = {
    fetchCandles: vi.fn().mockImplementation((_sym: string, tf: string) => {
      return Promise.resolve(generateFreshCandles(tf as ScannerTimeframe, 50));
    }),
    fetchTicker: vi.fn(),
  };

  it('retrieves and caches timeframe candles respecting TTL', async () => {
    const store = new MultiTimeframeCandleStore(mockProvider, 50);

    const s1 = await store.getSeries('BTCUSDT', '1h');
    expect(s1.candles.length).toBe(50);
    expect(s1.isFresh).toBe(true);
    expect(mockProvider.fetchCandles).toHaveBeenCalledTimes(1);

    // Call 2: Within TTL (5 minutes for 1h)
    const s2 = await store.getSeries('BTCUSDT', '1h');
    expect(s2.candles.length).toBe(50);
    // Provider should not be called again
    expect(mockProvider.fetchCandles).toHaveBeenCalledTimes(1);
  });

  it('fetches multi-timeframe snapshot across requested intervals', async () => {
    const store = new MultiTimeframeCandleStore(mockProvider, 50);
    const snapshot = await store.getMultiTimeframeSnapshot('ETHUSDT', ['1h', '15m', '5m']);

    expect(snapshot.availableTimeframes).toContain('1h');
    expect(snapshot.availableTimeframes).toContain('15m');
    expect(snapshot.availableTimeframes).toContain('5m');
    expect(snapshot.isFullyDegraded).toBe(false);
  });

  it('handles provider failures gracefully by marking timeframe as degraded', async () => {
    const failingProvider: ICandleProvider = {
      fetchCandles: vi.fn().mockRejectedValue(new Error('Network timeout')),
      fetchTicker: vi.fn(),
    };

    const store = new MultiTimeframeCandleStore(failingProvider, 50);
    const series = await store.getSeries('FAIL_COIN', '15m');

    expect(series.isDegraded).toBe(true);
    expect(series.candles.length).toBe(0);
    expect(series.degradationReason).toContain('Network timeout');
  });
});
