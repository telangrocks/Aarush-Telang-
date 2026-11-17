import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PublicMarketDataService } from '../../infrastructure/market-data/PublicMarketDataService';
import { PublicMarketDataCoordinator } from '../../infrastructure/market-data/PublicMarketDataCoordinator';
import { SingleFlightCoalescer } from '../../infrastructure/cache/SingleFlightCoalescer';
import { LruTtlCache } from '../../infrastructure/cache/LruTtlCache';
import { getKey, __resetDerivedKeyCacheForTests, __getDerivedKeyCacheStatsForTests, encrypt, decrypt } from '../../crypto';
import { handleGetMarketOpportunities, handleGetPersonalizedMarketCandidates, handleGetTicker, __resetPublicOpportunityStateForTests } from '../../handlers/exchange';
import { CandleValidator } from '../../infrastructure/exchange/CandleValidator';
import { RequestPriority } from '../../infrastructure/exchange/pacing';
import { TradingBot } from '../../trading-bot';
import { StrategyOrchestrator } from '../orchestrator/StrategyOrchestrator';
import { ExchangeManager } from '../../exchanges';
import { BybitAdapter } from '../../infrastructure/exchange/adapters/BybitAdapter';
import BigNumber from 'bignumber.js';

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

  describe('6. Live Ticker Single-Owner Retry, DO RPC Safety & Breaker Isolation', () => {
    const createTickerContext = (env: any, symbol: string) => ({
      get: vi.fn().mockReturnValue({ sub: 'user-ticker-test' }),
      req: {
        query: vi.fn().mockImplementation((k: string) => (k === 'symbol' ? symbol : undefined)),
      },
      env,
      status: vi.fn(),
      json: vi.fn().mockImplementation((body: any) => body),
      header: vi.fn(),
    } as any);

    const createConnectedUserDb = (exchangeEnvironment: 'demo' | 'mainnet' = 'demo') => ({
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: exchangeEnvironment,
            exchange_region: 'india',
            exchange_api_key_encrypted: 'enc-key',
            exchange_api_secret_encrypted: 'enc-sec',
          }),
        }),
      }),
    });

    it('recovers cleanly from transient ticker failure on both DO-bound and unbound paths', async () => {
      const sampleTicker = {
        symbol: 'ETH/USDT',
        last: new BigNumber(3500),
        high: new BigNumber(3600),
        low: new BigNumber(3400),
        volume: new BigNumber(12000),
        quoteVolume: new BigNumber(42000000),
        percentage: 2.5,
      };

      // 1) DO-bound transient recovery via PublicMarketDataCoordinator
      let doAttempts = 0;
      const doAdapter = {
        fetchTickers: vi.fn().mockImplementation(async () => {
          doAttempts++;
          if (doAttempts === 1) throw new Error('Transient 503 from Bybit');
          return [sampleTicker];
        }),
      };
      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(doAdapter as any);

      const coordinator = new PublicMarketDataCoordinator(
        { storage: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() }, blockConcurrencyWhile: (fn: any) => fn() } as any,
        { ENVIRONMENT: 'production' } as any
      );
      const doNamespace = {
        idFromName: vi.fn((name: string) => ({ toString: () => name })),
        get: vi.fn(() => ({ fetch: (req: Request) => coordinator.fetch(req) })),
      };

      const doCtx = createTickerContext({ DB: createConnectedUserDb('demo'), PUBLIC_MARKET_COORDINATOR: doNamespace }, 'ETH/USDT');
      const doBody = await handleGetTicker(doCtx) as any;

      expect(doCtx.status).not.toHaveBeenCalledWith(503);
      expect(doBody.symbol).toBe('ETH/USDT');
      expect(doBody.price).toBe(3500);
      expect(doBody.volume24h).toBe(12000);
      expect(doBody.quoteVolume24h).toBe(42000000);
      expect(doBody.highPrice24h).toBe(3600);
      expect(doBody.lowPrice24h).toBe(3400);
      expect(doBody.priceChangePercent24h).toBe(2.5);
      expect(doAdapter.fetchTickers).toHaveBeenCalledTimes(2);

      // 2) Unbound (no coordinator) transient recovery owned by PublicMarketDataService
      PublicMarketDataService.getInstance().clearCaches();
      let unboundAttempts = 0;
      const unboundAdapter = {
        fetchTickers: vi.fn().mockImplementation(async () => {
          unboundAttempts++;
          if (unboundAttempts === 1) throw new Error('Transient socket reset');
          return [sampleTicker];
        }),
      };
      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(unboundAdapter as any);

      const unboundCtx = createTickerContext({ DB: createConnectedUserDb('mainnet') }, 'ETH');
      const unboundBody = await handleGetTicker(unboundCtx) as any;

      expect(unboundCtx.status).not.toHaveBeenCalledWith(503);
      expect(unboundBody.symbol).toBe('ETH/USDT');
      expect(unboundBody.price).toBe(3500);
      expect(unboundAdapter.fetchTickers).toHaveBeenCalledTimes(2);
    });

    it('bounds retries strictly to 3 attempts with NO Worker fallback when DO persistently fails (HTTP 500)', async () => {
      const doAdapter = {
        fetchTickers: vi.fn().mockRejectedValue(new Error('Persistent Bybit outage')),
      };
      const workerAdapter = {
        fetchTickers: vi.fn().mockResolvedValue([{ symbol: 'BTC/USDT', last: new BigNumber(65000), high: new BigNumber(66000), low: new BigNumber(64000), volume: new BigNumber(1), quoteVolume: new BigNumber(65000) }]),
      };

      // Only 1 getProvider call should ever occur (inside DO). Any second call would expose Worker fallback.
      const getProviderSpy = vi.spyOn(ExchangeManager, 'getProvider')
        .mockResolvedValueOnce(doAdapter as any)
        .mockResolvedValueOnce(workerAdapter as any);

      const coordinator = new PublicMarketDataCoordinator(
        { storage: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() }, blockConcurrencyWhile: (fn: any) => fn() } as any,
        { ENVIRONMENT: 'production' } as any
      );
      const observedStatuses: number[] = [];
      const doNamespace = {
        idFromName: vi.fn((name: string) => ({ toString: () => name })),
        get: vi.fn(() => ({
          fetch: async (req: Request) => {
            const resp = await coordinator.fetch(req);
            observedStatuses.push(resp.status);
            return resp;
          },
        })),
      };

      const ctx = createTickerContext({ DB: createConnectedUserDb('demo'), PUBLIC_MARKET_COORDINATOR: doNamespace }, 'BTC/USDT');
      const res = await handleGetTicker(ctx) as any;

      expect(observedStatuses).toEqual([500]);
      expect(ctx.status).toHaveBeenCalledWith(503);
      expect(res.code).toBe('EXCHANGE_UNAVAILABLE');
      expect(doAdapter.fetchTickers).toHaveBeenCalledTimes(3);
      expect(workerAdapter.fetchTickers).not.toHaveBeenCalled();
      expect(getProviderSpy).toHaveBeenCalledTimes(1);
    });

    it('DO RPC exception after DO upstream attempt(s) NEVER initiates direct Worker fallback', async () => {
      const doAdapter = {
        fetchTickers: vi.fn().mockResolvedValue([
          { symbol: 'BTC/USDT', last: new BigNumber(65000), high: new BigNumber(66000), low: new BigNumber(64000), volume: new BigNumber(10), quoteVolume: new BigNumber(650000) },
        ]),
      };
      const workerAdapter = {
        fetchTickers: vi.fn(),
      };
      const getProviderSpy = vi.spyOn(ExchangeManager, 'getProvider')
        .mockResolvedValueOnce(doAdapter as any)
        .mockResolvedValueOnce(workerAdapter as any);

      const coordinator = new PublicMarketDataCoordinator(
        { storage: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() }, blockConcurrencyWhile: (fn: any) => fn() } as any,
        { ENVIRONMENT: 'production' } as any
      );

      const doNamespace = {
        idFromName: vi.fn((name: string) => ({ toString: () => name })),
        get: vi.fn(() => ({
          fetch: async (req: Request) => {
            // Execute real coordinator upstream work, then simulate ambiguous RPC failure losing the response
            await coordinator.fetch(req);
            throw new Error('Durable Object RPC connection lost');
          },
        })),
      };

      const ctx = createTickerContext({ DB: createConnectedUserDb('demo'), PUBLIC_MARKET_COORDINATOR: doNamespace }, 'BTC/USDT');
      const res = await handleGetTicker(ctx) as any;

      expect(ctx.status).toHaveBeenCalledWith(503);
      expect(res.code).toBe('EXCHANGE_UNAVAILABLE');
      expect(res.message).toContain('Durable Object RPC connection lost');
      expect(doAdapter.fetchTickers).toHaveBeenCalledTimes(1);
      expect(workerAdapter.fetchTickers).not.toHaveBeenCalled();
      expect(getProviderSpy).toHaveBeenCalledTimes(1);
    });

    it('bounds unbound direct fallback retries strictly to 3 attempts when coordinator is unconfigured', async () => {
      const directAdapter = {
        fetchTickers: vi.fn().mockRejectedValue(new Error('Bybit network timeout')),
      };
      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(directAdapter as any);

      const ctx = createTickerContext({ DB: createConnectedUserDb('mainnet') }, 'BTC/USDT');
      const res = await handleGetTicker(ctx) as any;

      expect(ctx.status).toHaveBeenCalledWith(503);
      expect(res.code).toBe('EXCHANGE_UNAVAILABLE');
      expect(directAdapter.fetchTickers).toHaveBeenCalledTimes(3);
    });

    it('never opens or modifies shared ExchangeManager Bybit circuit breaker across repeated public ticker failures', async () => {
      const publicBybitAdapter = new BybitAdapter();
      await publicBybitAdapter.connect({ environment: 'demo', region: 'india' });
      vi.spyOn(publicBybitAdapter, 'fetchTickers').mockRejectedValue(new Error('Upstream public ticker 503'));

      const orderBybitAdapter = new BybitAdapter();
      await orderBybitAdapter.connect({ environment: 'demo', region: 'india', apiKey: 'k', secret: 's' });
      vi.spyOn(orderBybitAdapter, 'createOrder').mockResolvedValue({
        id: 'order-isolation-1',
        clientOrderId: 'client-isolation-1',
        symbol: 'BTC/USDT',
        type: 'market',
        side: 'buy',
        price: new BigNumber(65000),
        amount: new BigNumber(0.01),
        cost: new BigNumber(650),
        filled: new BigNumber(0.01),
        remaining: new BigNumber(0),
        status: 'closed',
        timestamp: Date.now(),
      });

      const orchestrator = (ExchangeManager as any).orchestrator;
      const breakerBefore = orchestrator.getCircuitBreaker('bybit');
      breakerBefore.recordSuccess();
      expect(breakerBefore.getState()).toBe('CLOSED');

      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(publicBybitAdapter as any);
      const executeOrchestratedSpy = vi.spyOn(ExchangeManager, 'executeOrchestrated');

      // Run 2 full cycles (2 x 3 = 6 failures, exceeding CircuitBreaker failureThreshold = 5)
      const ctx1 = createTickerContext({ DB: createConnectedUserDb('demo') }, 'BTC/USDT');
      const res1 = await handleGetTicker(ctx1) as any;
      expect(ctx1.status).toHaveBeenCalledWith(503);
      expect(res1.code).toBe('EXCHANGE_UNAVAILABLE');

      PublicMarketDataService.getInstance().clearCaches();
      const ctx2 = createTickerContext({ DB: createConnectedUserDb('demo') }, 'ETH/USDT');
      const res2 = await handleGetTicker(ctx2) as any;
      expect(ctx2.status).toHaveBeenCalledWith(503);
      expect(res2.code).toBe('EXCHANGE_UNAVAILABLE');

      expect(publicBybitAdapter.fetchTickers).toHaveBeenCalledTimes(6);
      expect(executeOrchestratedSpy).not.toHaveBeenCalled();
      expect(orchestrator.getCircuitBreaker('bybit').getState()).toBe('CLOSED');

      // Shared trading path must remain completely unblocked
      const placed = await ExchangeManager.executeIdempotentOrder(orderBybitAdapter, {
        symbol: 'BTC/USDT',
        type: 'market',
        side: 'buy',
        amount: new BigNumber(0.01),
      });
      expect(placed.id).toBe('order-isolation-1');
    });

    it('isolates demo vs mainnet DO/L1/L2 caches, propagates ?environment=&region=, and normalizes symbols and numeric strings', async () => {
      const seenCoordinatorUrls: string[] = [];
      const seenAdapterHosts: Array<{ env: string; host: string }> = [];

      const demoAdapter = new BybitAdapter();
      await demoAdapter.connect({ environment: 'demo', region: 'india' });
      vi.spyOn(demoAdapter, 'fetchTickers').mockImplementation(async () => {
        seenAdapterHosts.push({ env: 'demo', host: demoAdapter.getHost() });
        // Simulate raw strings / BigNumber-free payloads after JSON deserialization + SymbolResolver variants
        return [
          {
            symbol: 'ETH/USDT',
            last: '3510.50',
            high: '3550.00',
            low: '3480.00',
            volume: '15000',
            quoteVolume: '52657500',
            percentage: '1.75',
          } as any,
        ];
      });

      const mainnetAdapter = new BybitAdapter();
      await mainnetAdapter.connect({ environment: 'mainnet', region: 'india' });
      vi.spyOn(mainnetAdapter, 'fetchTickers').mockImplementation(async () => {
        seenAdapterHosts.push({ env: 'mainnet', host: mainnetAdapter.getHost() });
        return [
          {
            symbol: 'ETH/USDT',
            timestamp: Date.now(),
            last: new BigNumber(3599.25),
            bid: new BigNumber(3598),
            ask: new BigNumber(3600),
            high: new BigNumber(3650),
            low: new BigNumber(3520),
            volume: new BigNumber(90000),
            quoteVolume: new BigNumber(323932500),
            percentage: 4.1,
          },
        ];
      });

      vi.spyOn(ExchangeManager, 'getProvider').mockImplementation(async (_exch, cfg) =>
        (cfg.environment === 'demo' ? demoAdapter : mainnetAdapter) as any
      );

      const coordinators = new Map<string, PublicMarketDataCoordinator>();
      const getCoordinator = (key: string) => {
        let coord = coordinators.get(key);
        if (!coord) {
          coord = new PublicMarketDataCoordinator(
            { storage: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() }, blockConcurrencyWhile: (fn: any) => fn() } as any,
            { ENVIRONMENT: 'production' } as any
          );
          coordinators.set(key, coord);
        }
        return coord;
      };

      const doNamespace = {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn((id: string) => ({
          fetch: (req: Request) => {
            seenCoordinatorUrls.push(req.url);
            return getCoordinator(id).fetch(req);
          },
        })),
      };

      // Demo user querying with bare base symbol "ETH" and concatenated "ETHUSDT"
      const demoCtxBase = createTickerContext({ DB: createConnectedUserDb('demo'), PUBLIC_MARKET_COORDINATOR: doNamespace }, 'ETH');
      const demoBodyBase = await handleGetTicker(demoCtxBase) as any;
      expect(demoBodyBase.symbol).toBe('ETH/USDT');
      expect(demoBodyBase.price).toBe(3510.5);
      expect(demoBodyBase.volume24h).toBe(15000);
      expect(demoBodyBase.priceChangePercent24h).toBe(1.75);

      const demoCtxRaw = createTickerContext({ DB: createConnectedUserDb('demo'), PUBLIC_MARKET_COORDINATOR: doNamespace }, 'ETHUSDT');
      const demoBodyRaw = await handleGetTicker(demoCtxRaw) as any;
      expect(demoBodyRaw.price).toBe(3510.5);

      // Mainnet user must NOT read demo's L1 or DO cache
      const mainnetCtx = createTickerContext({ DB: createConnectedUserDb('mainnet'), PUBLIC_MARKET_COORDINATOR: doNamespace }, 'ETH/USDT');
      const mainnetBody = await handleGetTicker(mainnetCtx) as any;
      expect(mainnetBody.price).toBe(3599.25);
      expect(mainnetBody.volume24h).toBe(90000);

      expect(seenCoordinatorUrls).toContain('http://coordinator/tickers?environment=demo&region=india');
      expect(seenCoordinatorUrls).toContain('http://coordinator/tickers?environment=mainnet&region=india');
      expect(seenAdapterHosts).toEqual([
        { env: 'demo', host: 'https://api-demo.bybit.com' },
        { env: 'mainnet', host: 'https://api.bybit.com' },
      ]);
    });
  });

  describe('7. Fail-Closed Coordinator Security, Pacing & Discovery Isolation', () => {
    const createMockCandles = (tf: '5m' | '15m' | '1h' | '4h' = '5m', count = 65) => {
      const tfMs = CandleValidator.timeframeToMs(tf);
      const start = Date.now() - count * tfMs;
      return Array.from({ length: count }, (_, i) => {
        const px = 100 + i * 0.8;
        return {
          timestamp: start + i * tfMs,
          openTime: start + i * tfMs,
          open: px - 0.3,
          high: px + 1.0,
          low: px - 1.0,
          close: px,
          volume: 15000 + i * 100,
        };
      });
    };

    const sampleMarkets = [
      {
        id: 'SOLUSDT',
        symbol: 'SOL/USDT',
        base: 'SOL',
        quote: 'USDT',
        active: true,
        category: 'linear',
        contractType: 'LinearPerpetual',
        precision: { price: 0.01, amount: 0.1 },
        limits: { amount: { min: 0.1, max: 5000 }, cost: { min: 5 } },
      },
    ];

    const sampleTickers = [
      {
        symbol: 'SOL/USDT',
        last: 150,
        bid: 149.95,
        ask: 150.05,
        high: 156,
        low: 144,
        volume: 500000,
        quoteVolume: 75_000_000,
        percentage: 2.5,
      },
    ];

    const createUserDb = (exchangeEnvironment: 'demo' | 'mainnet' = 'demo') => ({
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: exchangeEnvironment,
            exchange_region: 'india',
          }),
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    });

    const createDiscoveryContext = (env: any, budget = '100') => ({
      get: vi.fn().mockImplementation((k: string) => (k === 'jwtPayload' ? { sub: 'user-coord-sec' } : undefined)),
      req: {
        query: vi.fn().mockImplementation((k: string) => (k === 'budget' ? budget : undefined)),
      },
      env,
      status: vi.fn(),
      json: vi.fn().mockImplementation((body: any) => body),
      header: vi.fn(),
    } as any);

    it('never falls back to direct CCXT adapters when PUBLIC_MARKET_COORDINATOR fails on /klines, /markets, or /opportunities', async () => {
      const service = PublicMarketDataService.getInstance();
      const directAdapter = {
        fetchMarkets: vi.fn().mockResolvedValue(sampleMarkets),
        fetchTickers: vi.fn().mockResolvedValue(sampleTickers),
        fetchKlines: vi.fn().mockResolvedValue(createMockCandles('5m')),
      };
      const getProviderSpy = vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(directAdapter as any);

      // 1) Coordinator returns HTTP 500 / HTTP 403 -> rejects cleanly with ZERO direct calls
      const httpErrorCoordinatorEnv: any = {
        PUBLIC_MARKET_COORDINATOR: {
          idFromName: vi.fn((n: string) => n),
          get: vi.fn(() => ({
            fetch: vi.fn().mockImplementation(async (req: Request) => {
              const path = new URL(req.url).pathname;
              if (path === '/klines') {
                return Response.json({ error: 'CloudFront WAF 403 block' }, { status: 403 });
              }
              return Response.json({ error: `Upstream outage on ${path}` }, { status: 500 });
            }),
          })),
        },
      };

      await expect(service.getKlines(httpErrorCoordinatorEnv, 'SOL/USDT', '5m', 100, 'bybit', 'demo', 'india')).rejects.toThrow(/CloudFront WAF 403 block/);
      await expect(service.getMarkets(httpErrorCoordinatorEnv, 'bybit', 'demo', 'india')).rejects.toThrow(/Upstream outage on \/markets/);
      await expect(service.getOpportunities(httpErrorCoordinatorEnv, 'bybit', 'demo', 'india')).rejects.toThrow(/Upstream outage on \/opportunities/);

      expect(getProviderSpy).not.toHaveBeenCalled();
      expect(directAdapter.fetchKlines).not.toHaveBeenCalled();
      expect(directAdapter.fetchMarkets).not.toHaveBeenCalled();
      expect(directAdapter.fetchTickers).not.toHaveBeenCalled();

      // 2) Coordinator throws RPC error -> rejects cleanly with ZERO direct calls
      service.clearCaches();
      const rpcThrowCoordinatorEnv: any = {
        PUBLIC_MARKET_COORDINATOR: {
          idFromName: vi.fn((n: string) => n),
          get: vi.fn(() => ({
            fetch: vi.fn().mockRejectedValue(new Error('Coordinator DO RPC timeout')),
          })),
        },
      };

      await expect(service.getKlines(rpcThrowCoordinatorEnv, 'SOL/USDT', '15m', 100, 'bybit', 'demo', 'india')).rejects.toThrow(/Coordinator DO RPC timeout/);
      await expect(service.getMarkets(rpcThrowCoordinatorEnv, 'bybit', 'demo', 'india')).rejects.toThrow(/Coordinator DO RPC timeout/);
      await expect(service.getOpportunities(rpcThrowCoordinatorEnv, 'bybit', 'demo', 'india')).rejects.toThrow(/Coordinator DO RPC timeout/);
      expect(getProviderSpy).not.toHaveBeenCalled();

      // 3) Malformed truthy binding -> fails closed rather than silently bypassing
      service.clearCaches();
      const malformedEnv: any = { PUBLIC_MARKET_COORDINATOR: {} };
      await expect(service.getKlines(malformedEnv, 'SOL/USDT', '1h', 100, 'bybit', 'demo', 'india')).rejects.toThrow(/Invalid PUBLIC_MARKET_COORDINATOR binding/);
      expect(getProviderSpy).not.toHaveBeenCalled();

      // 4) Coordinator /opportunities returning 200 with screenedCount=0 never launches direct fallback scan
      service.clearCaches();
      const zeroScreenedEnv: any = {
        PUBLIC_MARKET_COORDINATOR: {
          idFromName: vi.fn((n: string) => n),
          get: vi.fn(() => ({
            fetch: vi.fn().mockResolvedValue(
              Response.json({
                timestamp: Date.now(),
                executionDurationMs: 1,
                universeSize: 1,
                eligibleCount: 1,
                qualityCount: 1,
                screenedCount: 0,
                allQualifiedOpportunities: [],
                topOpportunities: [],
                telemetry: {},
              })
            ),
          })),
        },
      };
      const zeroScan = await service.getOpportunities(zeroScreenedEnv, 'bybit', 'demo', 'india');
      expect(zeroScan.screenedCount).toBe(0);
      expect(getProviderSpy).not.toHaveBeenCalled();
    });

    it('exchange.ts discovery routes propagate coordinator failures fail-closed without calling publicAdapter klines/markets', async () => {
      const publicAdapter = {
        fetchMarkets: vi.fn().mockResolvedValue(sampleMarkets),
        fetchTickers: vi.fn().mockResolvedValue(sampleTickers),
        fetchCandles: vi.fn().mockResolvedValue(createMockCandles('5m')),
        fetchKlines: vi.fn().mockResolvedValue(createMockCandles('5m')),
      };
      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(publicAdapter as any);

      // Coordinator serves /markets and /tickers OK, but fails on /klines
      const klinesFailDoEnv: any = {
        DB: createUserDb('demo'),
        ENCRYPTION_KEY: 'test-key-32-chars-minimum-sample!!',
        PUBLIC_MARKET_COORDINATOR: {
          idFromName: vi.fn((n: string) => n),
          get: vi.fn(() => ({
            fetch: vi.fn().mockImplementation(async (req: Request) => {
              const path = new URL(req.url).pathname;
              if (path === '/markets') return Response.json(sampleMarkets);
              if (path === '/tickers') return Response.json(sampleTickers);
              return Response.json({ error: 'Coordinator kline pacing fault' }, { status: 500 });
            }),
          })),
        },
      };

      const oppsCtx = createDiscoveryContext(klinesFailDoEnv);
      const oppsRes = await handleGetMarketOpportunities(oppsCtx) as any;
      expect(oppsCtx.status).toHaveBeenCalledWith(503);
      expect(oppsRes.code).toBe('MARKET_DATA_DEGRADED');
      expect(publicAdapter.fetchCandles).not.toHaveBeenCalled();
      expect(publicAdapter.fetchKlines).not.toHaveBeenCalled();

      __resetPublicOpportunityStateForTests();

      const candCtx = createDiscoveryContext(klinesFailDoEnv);
      const candRes = await handleGetPersonalizedMarketCandidates(candCtx) as any;
      expect(candCtx.status).toHaveBeenCalledWith(503);
      expect(candRes.code).toBe('MARKET_DATA_DEGRADED');
      expect(publicAdapter.fetchCandles).not.toHaveBeenCalled();
      expect(publicAdapter.fetchKlines).not.toHaveBeenCalled();

      // Coordinator fails on /markets -> fails closed with 503 instead of synthesizing top-3 pairs
      __resetPublicOpportunityStateForTests();
      const marketsFailDoEnv: any = {
        DB: createUserDb('demo'),
        ENCRYPTION_KEY: 'test-key-32-chars-minimum-sample!!',
        PUBLIC_MARKET_COORDINATOR: {
          idFromName: vi.fn((n: string) => n),
          get: vi.fn(() => ({
            fetch: vi.fn().mockResolvedValue(Response.json({ error: 'Coordinator /markets unavailable' }, { status: 503 })),
          })),
        },
      };
      const candMarketsErrCtx = createDiscoveryContext(marketsFailDoEnv);
      const candMarketsErrRes = await handleGetPersonalizedMarketCandidates(candMarketsErrCtx) as any;
      expect(candMarketsErrCtx.status).toHaveBeenCalledWith(503);
      expect(candMarketsErrRes.success).toBe(false);
    });

    it('keeps Demo isolation fail-closed across PublicMarketDataService and discovery routes when mainnet is requested in staging', async () => {
      const publicAdapter = {
        fetchMarkets: vi.fn().mockResolvedValue(sampleMarkets),
        fetchTickers: vi.fn().mockResolvedValue(sampleTickers),
        fetchCandles: vi.fn().mockResolvedValue(createMockCandles('5m')),
        fetchKlines: vi.fn().mockResolvedValue(createMockCandles('5m')),
      };
      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(publicAdapter as any);

      const coordFetchSpy = vi.fn().mockResolvedValue(Response.json([]));
      const stagingMainnetUserEnv: any = {
        ENVIRONMENT: 'demo',
        STAGING_ISOLATION_MODE: 'demo',
        DB: createUserDb('mainnet'),
        ENCRYPTION_KEY: 'test-key-32-chars-minimum-sample!!',
        PUBLIC_MARKET_COORDINATOR: {
          idFromName: vi.fn((n: string) => n),
          get: vi.fn(() => ({ fetch: coordFetchSpy })),
        },
      };

      const service = PublicMarketDataService.getInstance();
      await expect(service.getMarkets(stagingMainnetUserEnv, 'bybit', 'mainnet', 'india')).rejects.toThrow(/Mainnet is blocked in staging/i);
      await expect(service.getTickers(stagingMainnetUserEnv, 'bybit', 'mainnet', 'india')).rejects.toThrow(/Mainnet is blocked in staging/i);
      await expect(service.getKlines(stagingMainnetUserEnv, 'SOL/USDT', '5m', 100, 'bybit', 'mainnet', 'india')).rejects.toThrow(/Mainnet is blocked in staging/i);
      await expect(service.getOpportunities(stagingMainnetUserEnv, 'bybit', 'mainnet', 'india')).rejects.toThrow(/Mainnet is blocked in staging/i);
      expect(coordFetchSpy).not.toHaveBeenCalled();

      // Direct handler invocation bypassing middleware still blocks mainnet candle fetches
      const oppsCtx = createDiscoveryContext(stagingMainnetUserEnv);
      const oppsRes = await handleGetMarketOpportunities(oppsCtx) as any;
      expect(oppsCtx.status).toHaveBeenCalledWith(503);
      expect(oppsRes.code).toBe('MARKET_DATA_DEGRADED');
      expect(publicAdapter.fetchCandles).not.toHaveBeenCalled();
      expect(publicAdapter.fetchKlines).not.toHaveBeenCalled();

      __resetPublicOpportunityStateForTests();
      const candCtx = createDiscoveryContext(stagingMainnetUserEnv);
      const candRes = await handleGetPersonalizedMarketCandidates(candCtx) as any;
      expect(candCtx.status).toHaveBeenCalledWith(503);
      expect(candRes.success).toBe(false);
      expect(publicAdapter.fetchCandles).not.toHaveBeenCalled();
      expect(publicAdapter.fetchKlines).not.toHaveBeenCalled();
    });

    it('preserves direct adapter fallback when PUBLIC_MARKET_COORDINATOR binding is genuinely absent', async () => {
      const unboundAdapter = {
        fetchMarkets: vi.fn().mockResolvedValue(sampleMarkets),
        fetchTickers: vi.fn().mockResolvedValue(sampleTickers),
        fetchCandles: vi.fn().mockImplementation((_sym: string, tf: any) => Promise.resolve(createMockCandles(tf, 65))),
        fetchKlines: vi.fn().mockImplementation((_sym: string, tf: any) => Promise.resolve(createMockCandles(tf, 65))),
      };
      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(unboundAdapter as any);

      const service = PublicMarketDataService.getInstance();
      const unboundEnv: any = { DB: createUserDb('demo'), ENCRYPTION_KEY: 'test-key-32-chars-minimum-sample!!' };

      const klines = await service.getKlines(unboundEnv, 'SOL/USDT', '5m', 50, 'bybit', 'demo', 'india');
      expect(klines.length).toBe(50);
      expect(unboundAdapter.fetchKlines).toHaveBeenCalledTimes(1);

      const opps = await service.getOpportunities(unboundEnv, 'bybit', 'demo', 'india');
      expect(opps.screenedCount).toBeGreaterThan(0);

      __resetPublicOpportunityStateForTests();
      const candCtx = createDiscoveryContext(unboundEnv);
      const candRes = await handleGetPersonalizedMarketCandidates(candCtx) as any;
      expect(Array.isArray(candRes)).toBe(true);
      expect(candRes.length).toBeGreaterThan(0);
    });

    it('PublicMarketDataCoordinator routes /klines through ExchangeRequestScheduler at P3_MARKET_DATA while preserving SingleFlight and cache', async () => {
      const fetchTimes: number[] = [];
      const mockAdapter = {
        fetchKlines: vi.fn().mockImplementation(async (_sym: string, tf: string) => {
          fetchTimes.push(Date.now());
          return createMockCandles(tf as any, 205);
        }),
      };
      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);

      const coordinator = new PublicMarketDataCoordinator(
        { storage: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() }, blockConcurrencyWhile: (fn: any) => fn() } as any,
        { ENVIRONMENT: 'production' } as any
      );
      const scheduleSpy = vi.spyOn((coordinator as any).scheduler, 'schedule');

      // 1) Concurrent requests for the SAME symbol+timeframe coalesce into 1 scheduled call + 1 upstream fetch
      const concurrentSame = await Promise.all(
        Array.from({ length: 4 }, () =>
          coordinator.fetch(new Request('http://coordinator/klines?symbol=SOL/USDT&interval=5m&limit=60'))
        )
      );
      for (const r of concurrentSame) expect(r.status).toBe(200);
      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      expect(scheduleSpy).toHaveBeenCalledWith(RequestPriority.P3_MARKET_DATA, expect.any(Function));
      expect(mockAdapter.fetchKlines).toHaveBeenCalledTimes(1);

      // 2) Subsequent request within 15s cache TTL hits klineCache with ZERO additional scheduler or upstream calls
      const warmCacheResp = await coordinator.fetch(
        new Request('http://coordinator/klines?symbol=SOL/USDT&interval=5m&limit=60')
      );
      expect(warmCacheResp.status).toBe(200);
      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      expect(mockAdapter.fetchKlines).toHaveBeenCalledTimes(1);

      // 3) Consecutive distinct klines requests (15m, 1h) are P3-paced (>= 572ms nominal spacing)
      const [r15m, r1h] = await Promise.all([
        coordinator.fetch(new Request('http://coordinator/klines?symbol=SOL/USDT&interval=15m&limit=60')),
        coordinator.fetch(new Request('http://coordinator/klines?symbol=SOL/USDT&interval=1h&limit=60')),
      ]);
      expect(r15m.status).toBe(200);
      expect(r1h.status).toBe(200);
      expect(scheduleSpy).toHaveBeenCalledTimes(3);
      expect(mockAdapter.fetchKlines).toHaveBeenCalledTimes(3);
      expect(fetchTimes[1] - fetchTimes[0]).toBeGreaterThanOrEqual(540);
      expect(fetchTimes[2] - fetchTimes[1]).toBeGreaterThanOrEqual(540);
    });
  });
});
