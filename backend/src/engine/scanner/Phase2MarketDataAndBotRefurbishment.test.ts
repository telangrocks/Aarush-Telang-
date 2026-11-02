import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PublicMarketDataService } from '../../infrastructure/market-data/PublicMarketDataService';
import { PublicMarketDataCoordinator } from '../../infrastructure/market-data/PublicMarketDataCoordinator';
import { SingleFlightCoalescer } from '../../infrastructure/cache/SingleFlightCoalescer';
import { LruTtlCache } from '../../infrastructure/cache/LruTtlCache';
import { getKey, __resetDerivedKeyCacheForTests, __getDerivedKeyCacheStatsForTests, encrypt, decrypt } from '../../crypto';
import { handleGetPersonalizedMarketCandidates, __resetPublicOpportunityStateForTests } from '../../handlers/exchange';
import { TradingBot } from '../../trading-bot';
import { StrategyOrchestrator } from '../orchestrator/StrategyOrchestrator';

describe('Phase 2 — Unified Public Market Data & Bot Refurbishment', () => {
  beforeEach(() => {
    __resetPublicOpportunityStateForTests();
    __resetDerivedKeyCacheForTests();
    vi.restoreAllMocks();
  });

  describe('1. 3-Tier Public Market Data Pipeline & Coalescing', () => {
    it('coalesces concurrent requests for markets and tickers into single upstream calls', async () => {
      const service = PublicMarketDataService.getInstance();
      service.clearCaches();

      const mockAdapter = {
        fetchMarkets: vi.fn().mockResolvedValue([
          { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true },
          { id: 'ETHUSDT', symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', active: true },
        ]),
        fetchTickers: vi.fn().mockResolvedValue([
          { symbol: 'BTC/USDT', price: 65000, last: 65000, bid: 64990, ask: 65010, quoteVolume: 1000000 },
          { symbol: 'ETH/USDT', price: 3500, last: 3500, bid: 3499, ask: 3501, quoteVolume: 500000 },
        ]),
      };

      const { ExchangeManager } = await import('../../exchanges');
      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

      const fakeEnv: any = {
        DB: {} as any,
        ENCRYPTION_KEY: 'test-key',
      };

      // 20 concurrent requests for markets
      const marketPromises = Array.from({ length: 20 }, () =>
        service.getMarkets(fakeEnv, 'bybit', 'mainnet', 'india')
      );
      const marketResults = await Promise.all(marketPromises);

      // Verify all received the exact same data
      expect(marketResults.length).toBe(20);
      for (const res of marketResults) {
        expect(res.length).toBe(2);
        expect(res[0].symbol).toBe('BTC/USDT');
      }
      // Single flight coalescing ensures upstream fetchMarkets was called only once
      expect(mockAdapter.fetchMarkets).toHaveBeenCalledTimes(1);

      // 20 concurrent requests for tickers
      const tickerPromises = Array.from({ length: 20 }, () =>
        service.getTickers(fakeEnv, 'bybit', 'mainnet', 'india')
      );
      const tickerResults = await Promise.all(tickerPromises);

      expect(tickerResults.length).toBe(20);
      expect(mockAdapter.fetchTickers).toHaveBeenCalledTimes(1);
    });

    it('PublicMarketDataCoordinator DO serves endpoints without durable SQLite writes', async () => {
      const mockStorage = {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
      };

      const mockState: any = {
        storage: mockStorage,
        blockConcurrencyWhile: (fn: any) => fn(),
      };

      const mockAdapter = {
        fetchMarkets: vi.fn().mockResolvedValue([
          { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', active: true },
        ]),
        fetchTickers: vi.fn().mockResolvedValue([
          { symbol: 'BTC/USDT', last: 65000, quoteVolume: 1000000 },
        ]),
        fetchKlines: vi.fn().mockResolvedValue([
          { timestamp: Date.now() - 300000, open: 64900, high: 65100, low: 64800, close: 65000, volume: 10 },
        ]),
      };

      const { ExchangeManager } = await import('../../exchanges');
      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

      const coordinator = new PublicMarketDataCoordinator(mockState, {
        ENVIRONMENT: 'production',
      } as any);

      // Request markets
      const reqMarkets = new Request('http://coordinator/markets');
      const resMarkets = await coordinator.fetch(reqMarkets);
      expect(resMarkets.status).toBe(200);
      const marketsData = await resMarkets.json() as any[];
      expect(marketsData.length).toBe(1);

      // Request tickers
      const reqTickers = new Request('http://coordinator/tickers');
      const resTickers = await coordinator.fetch(reqTickers);
      expect(resTickers.status).toBe(200);

      // Request klines with 205 depth
      const reqKlines = new Request('http://coordinator/klines?symbol=BTC/USDT&interval=5m&limit=205');
      const resKlines = await coordinator.fetch(reqKlines);
      expect(resKlines.status).toBe(200);

      // Verify ZERO durable SQLite writes were made (pure in-memory scheduler)
      expect(mockStorage.put).not.toHaveBeenCalled();
    });
  });

  describe('2. PBKDF2 Key Derivation In-Memory Cache (R-05)', () => {
    it('returns bit-for-bit identical CryptoKeys on repeated calls while caching derived keys', async () => {
      const secret = 'super-secret-passphrase-123';
      const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

      const key1 = await getKey(secret, salt);
      const key2 = await getKey(secret, salt);

      // Identical CryptoKey instance from cache
      expect(key1).toBe(key2);

      const stats = __getDerivedKeyCacheStatsForTests();
      expect(stats.hits).toBeGreaterThanOrEqual(1);

      // Verify encryption and decryption works transparently
      const plaintext = 'sensitive-exchange-api-secret';
      const encrypted = await encrypt(plaintext, secret);
      const decrypted = await decrypt(encrypted, secret);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('3. StrategyOrchestrator Snapshot Capture & Reuse', () => {
    it('captures lastSnapshot during executeCycle and exposes via getLastSnapshot()', async () => {
      const orchestrator = new StrategyOrchestrator();
      expect(orchestrator.getLastSnapshot()).toBeNull();

      const mockEngine: any = {
        getSnapshot: vi.fn().mockResolvedValue({
          symbol: 'BTC/USDT',
          timestamp: Date.now(),
          currentPrice: 65000,
          volume24h: 1000,
          quoteVolume24h: 65000000,
          candles: {
            '5m': [
              { timestamp: Date.now() - 300000, open: 64900, high: 65100, low: 64800, close: 65000, volume: 10 },
            ],
          },
          metadata: { priceChange24h: 100, priceChangePercent24h: 1.5, highPrice24h: 66000, lowPrice24h: 64000 },
        }),
      };

      orchestrator.setMarketDataEngine(mockEngine);

      const results = await orchestrator.executeCycle('BTC/USDT', 'ScalperV2', undefined, 1000);
      expect(results).toBeDefined();

      const snapshot = orchestrator.getLastSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot?.symbol).toBe('BTC/USDT');
      expect(snapshot?.currentPrice).toBe(65000);
    });
  });

  describe('4. TradingBot Crash-Wedge Auto-Recovery & Concurrency Guard (R-02)', () => {
    it('auto-recovers stale trade execution lock if lease exceeds 60 seconds', async () => {
      const storageMap = new Map<string, any>();
      storageMap.set('isExecutingTrade', true);
      storageMap.set('isExecutingTradeAt', Date.now() - 75_000); // 75s ago (stale)
      storageMap.set('userId', 'user-stale-lock');
      storageMap.set('runtimeState', {
        userId: 'user-stale-lock',
        isActive: false,
        coinId: 'BTCUSDT',
        activeIntents: new Map(),
        activePositions: [],
      });

      let blockPromise: Promise<void> | null = null;
      const mockStorage: any = {
        get: vi.fn().mockImplementation((k: string) => Promise.resolve(storageMap.get(k))),
        put: vi.fn().mockImplementation((k: string, v: any) => {
          storageMap.set(k, v);
          return Promise.resolve();
        }),
        delete: vi.fn().mockImplementation((k: string) => {
          storageMap.delete(k);
          return Promise.resolve();
        }),
        list: vi.fn().mockResolvedValue(new Map()),
        transaction: vi.fn().mockImplementation(async (cb: any) => {
          return await cb(mockStorage);
        }),
      };

      const mockState: any = {
        storage: mockStorage,
        blockConcurrencyWhile: (fn: any) => {
          blockPromise = fn();
          return blockPromise;
        },
      };

      const bot = new TradingBot(mockState, {
        DB: { prepare: vi.fn() } as any,
        ENCRYPTION_KEY: 'test-key',
      } as any);

      if (blockPromise) await blockPromise;

      // On cold restart, stale lock is cleared
      expect(mockStorage.put).toHaveBeenCalledWith('isExecutingTrade', false);
    });

    it('handles /exchange-invalidated: deactivates bot and clears credential/balance caches', async () => {
      const storageMap = new Map<string, any>();
      storageMap.set('userId', 'user-invalidated');
      storageMap.set('isActive', true);
      storageMap.set('coinId', 'BTCUSDT');

      const mockStorage: any = {
        get: vi.fn().mockImplementation((k: string) => Promise.resolve(storageMap.get(k))),
        put: vi.fn().mockImplementation((k: string, v: any) => {
          storageMap.set(k, v);
          return Promise.resolve();
        }),
        delete: vi.fn(),
        list: vi.fn().mockResolvedValue(new Map()),
      };

      const mockState: any = {
        storage: mockStorage,
        blockConcurrencyWhile: (fn: any) => fn(),
      };

      const bot = new TradingBot(mockState, {
        DB: { prepare: vi.fn() } as any,
        ENCRYPTION_KEY: 'test-key',
      } as any);

      const req = new Request('http://bot/exchange-invalidated', { method: 'POST' });
      const res = await bot.fetch(req);
      expect(res.status).toBe(200);

      // Bot deactivated in storage
      expect(mockStorage.put).toHaveBeenCalledWith('isActive', false);
    });
  });

  describe('5. DO SQLite Double-Write Elimination (O-06)', () => {
    it('executes protection and close intent persistence without secondary duplicate storage.put', async () => {
      const putCalls: string[] = [];
      const mockStorage: any = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockImplementation((k: string) => {
          putCalls.push(k);
          return Promise.resolve();
        }),
        delete: vi.fn(),
        list: vi.fn().mockResolvedValue(new Map()),
        transaction: vi.fn().mockImplementation(async (cb: any) => {
          const txn = {
            put: vi.fn().mockImplementation((k: string) => {
              putCalls.push(`txn:${k}`);
              return Promise.resolve();
            }),
            delete: vi.fn(),
          };
          return await cb(txn);
        }),
      };

      const mockState: any = {
        storage: mockStorage,
        blockConcurrencyWhile: (fn: any) => fn(),
      };

      const bot = new TradingBot(mockState, {
        DB: { prepare: vi.fn() } as any,
        ENCRYPTION_KEY: 'test-key',
      } as any);

      (bot as any).runtimeState = {
        userId: 'user-storage-opt',
        activeIntents: new Map(),
        activePositions: [],
      };

      // Persist protection intent
      const protectionIntent: any = {
        intentId: 'pos-123',
        positionId: 'pos-123',
        status: 'INTENT_PERSISTED',
      };
      await (bot as any).persistProtectionIntent(protectionIntent);

      // Verify that the put was inside transaction only and NOT duplicated outside
      const protPuts = putCalls.filter(k => k.includes('pos-123'));
      expect(protPuts.length).toBe(1);
      expect(protPuts[0]).toBe('txn:intent:protection:pos-123');

      // Persist close intent
      const closeIntent: any = {
        closeIntentId: 'close-456',
        status: 'INTENT_PERSISTED',
      };
      await (bot as any).persistCloseIntent(closeIntent);

      const closePuts = putCalls.filter(k => k.includes('close-456'));
      expect(closePuts.length).toBe(1);
      expect(closePuts[0]).toBe('txn:intent:close:close-456');
    });
  });
});
