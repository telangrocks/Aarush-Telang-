import { describe, it, expect, vi } from 'vitest';
import { MarketDataEngine } from './MarketDataEngine';
import { ICandleProvider } from './CandleProvider';
import { Timeframe } from './Timeframe';

describe('MarketDataEngine', () => {
  const mockTicker = {
    symbol: 'BTCUSDT',
    price: 60000,
    volume24h: 1000,
    quoteVolume24h: 60000000,
    priceChange24h: 1000,
    priceChangePercent24h: 1.69,
    highPrice24h: 61000,
    lowPrice24h: 59000,
    minNotional: 10,
    minOrderQty: 0.001
  };

  const mockCandle = {
    timestamp: 1234567890,
    open: 60000,
    high: 60100,
    low: 59900,
    close: 60050,
    volume: 10
  };

  const mockProvider: ICandleProvider = {
    fetchTicker: vi.fn().mockResolvedValue(mockTicker),
    fetchCandles: vi.fn().mockResolvedValue([mockCandle, mockCandle])
  };

  it('should fetch snapshot with requested timeframes', async () => {
    const engine = new MarketDataEngine(mockProvider);
    
    const timeframes: Timeframe[] = ['15m', '1h'];
    const snapshot = await engine.getSnapshot('BTCUSDT', timeframes);

    expect(mockProvider.fetchTicker).toHaveBeenCalledWith('BTCUSDT');
    expect(mockProvider.fetchCandles).toHaveBeenCalledWith('BTCUSDT', '15m');
    expect(mockProvider.fetchCandles).toHaveBeenCalledWith('BTCUSDT', '1h');

    expect(snapshot.symbol).toBe('BTCUSDT');
    expect(snapshot.currentPrice).toBe(60000);
    expect(snapshot.candles['15m'].length).toBe(2);
    expect(snapshot.candles['1h'].length).toBe(2);
    expect(snapshot.metadata.highPrice24h).toBe(61000);
  });

  it('should throw an error if no timeframes provided', async () => {
    const engine = new MarketDataEngine(mockProvider);
    await expect(engine.getSnapshot('BTCUSDT', [])).rejects.toThrow('At least one timeframe must be specified');
  });

  it('should throw an error if ticker fetch fails', async () => {
    const brokenProvider: ICandleProvider = {
      fetchTicker: vi.fn().mockResolvedValue(null),
      fetchCandles: vi.fn().mockResolvedValue([])
    };
    const engine = new MarketDataEngine(brokenProvider);
    await expect(engine.getSnapshot('BTCUSDT', ['5m'])).rejects.toThrow('Failed to fetch market ticker for symbol: BTCUSDT');
  });
});
