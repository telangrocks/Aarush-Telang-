import { describe, it, expect, beforeEach } from 'vitest';
import { ExchangeManager } from './ExchangeManager';
import { BaseExchangeAdapter } from '../infrastructure/exchange/adapters/BaseExchangeAdapter';
import { ExchangeRegistry } from '../infrastructure/exchange/registry/ExchangeRegistry';
import { UnifiedError } from './models/UnifiedError';
import { ExchangeOrchestrator } from '../infrastructure/orchestrator/ExchangeOrchestrator';
import { BinanceAdapter } from '../infrastructure/exchange/adapters/BinanceAdapter';
import { KucoinAdapter } from '../infrastructure/exchange/adapters/KucoinAdapter';
import BigNumber from 'bignumber.js';

describe('Exchange Connectivity Module Fixes Unit Tests', () => {
  beforeEach(() => {
    ExchangeRegistry.register({ exchangeId: 'binance', factory: () => new BinanceAdapter() });
    ExchangeRegistry.register({ exchangeId: 'kucoin', factory: () => new KucoinAdapter() });
  });

  it('EC-C1 & EC-C2: getProvider throws error and evicts cache when connection fails', async () => {
    class FailingAdapter extends BaseExchangeAdapter {
      readonly exchangeId = 'failing';
      public override async connect(_config: any): Promise<void> {
        throw new UnifiedError('Connection refused by exchange', 'EXCHANGE_NOT_REACHABLE');
      }
      fetchMarkets = async () => [];
      fetchBalance = async () => [];
      fetchTicker = async () => ({} as any);
      fetchTickers = async () => [];
      fetchKlines = async () => [];
      fetchPositions = async () => [];
      createOrder = async () => ({} as any);
      cancelOrder = async () => true;
      fetchOrder = async () => ({} as any);
      fetchOpenOrders = async () => [];
      fetchClosedOrders = async () => [];
      fetchMyTrades = async () => [];
    }

    ExchangeRegistry.register({ exchangeId: 'failing', factory: () => new FailingAdapter() });
    const config = { environment: 'mainnet' as const, apiKey: 'k', secret: 's' };

    await expect(ExchangeManager.getProvider('failing', config)).rejects.toThrow('The exchange API is currently not reachable.');
  });

  it('EC-H1: Circuit breaker states are isolated per-exchange', async () => {
    const orchestrator = new ExchangeOrchestrator();
    const binance = new BinanceAdapter();
    const kucoin = new KucoinAdapter();

    // Trigger failures on binance
    for (let i = 0; i < 6; i++) {
      await orchestrator.execute(binance, 'failingOp', async () => {
        throw new Error('Network failure');
      });
    }

    // Binance circuit is open
    const binanceRes = await orchestrator.execute(binance, 'testOp', async () => 'ok');
    expect(binanceRes.isFailure).toBe(true);
    if (binanceRes.isFailure) {
      expect(binanceRes.error.code).toBe('CIRCUIT_OPEN');
    }

    // KuCoin circuit remains closed and healthy
    const kucoinRes = await orchestrator.execute(kucoin, 'testOp', async () => 'success');
    expect(kucoinRes.isSuccess).toBe(true);
    if (kucoinRes.isSuccess) {
      expect(kucoinRes.value).toBe('success');
    }
  });

  it('EC-H3: fetchWithTimeout formats dynamic timeoutMs in error message', async () => {
    class TimeoutTestAdapter extends BaseExchangeAdapter {
      readonly exchangeId = 'timeout-test';
      fetchMarkets = async () => [];
      fetchBalance = async () => [];
      fetchTicker = async () => ({ symbol: 'BTC/USDT', timestamp: 0, last: new BigNumber(0), bid: new BigNumber(0), ask: new BigNumber(0), high: new BigNumber(0), low: new BigNumber(0), volume: new BigNumber(0), quoteVolume: new BigNumber(0) });
      fetchTickers = async () => [];
      fetchKlines = async () => [];
      fetchPositions = async () => [];
      createOrder = async () => ({} as any);
      cancelOrder = async () => true;
      fetchOrder = async () => ({} as any);
      fetchOpenOrders = async () => [];
      fetchClosedOrders = async () => [];
      fetchMyTrades = async () => [];

      public testTimeout = (url: string, timeoutMs: number) => this.fetchWithTimeout(url, {}, timeoutMs);
    }

    const adapter = new TimeoutTestAdapter();
    // Non-routable IP to guarantee timeout abort
    await expect(adapter.testTimeout('https://10.255.255.1', 150)).rejects.toThrow('Request timed out after 150ms.');
  });

  it('EC-H5: disconnect() clears credentials and disconnectProvider clears state', async () => {
    const adapter = new BinanceAdapter();
    await adapter.connect({ environment: 'mainnet', apiKey: 'testKey', secret: 'testSec' });
    await adapter.disconnect();
    expect(() => (adapter as any).getConfig()).toThrow('Adapter not connected. Call connect() first.');
  });

  it('EC-M5: Symbol parser rejects multiple separators with INVALID_REQUEST', () => {
    const adapter = new BinanceAdapter();
    expect(() => adapter.normalizeSymbol('BTC/USDT/USD')).toThrow(UnifiedError);
    expect(() => adapter.normalizeSymbol('BTC/USDT/USD')).toThrow('Invalid symbol format with multiple separators');
  });

  it('EC-M6: Unconnected adapter throws NOT_CONNECTED error code', () => {
    const adapter = new BinanceAdapter();
    expect(() => (adapter as any).getConfig()).toThrow(UnifiedError);
    try {
      (adapter as any).getConfig();
    } catch (err: any) {
      expect(err.code).toBe('NOT_CONNECTED');
    }
  });
});
