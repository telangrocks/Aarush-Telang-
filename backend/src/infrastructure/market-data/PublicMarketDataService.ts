import { Env } from '../../index';
import { ExchangeManager, ExchangeName, ExchangeEnvironment, ExchangeRegion } from '../../exchanges';
import { MultiTimeframeCandleStore, ScannerTimeframe } from '../../engine/scanner/MultiTimeframeCandleStore';
import { MarketOpportunityScanner, ScannerScanResult } from '../../engine/scanner/MarketOpportunityScanner';
import { DEFAULT_SCANNER_CONFIG } from '../../engine/scanner/ScannerTypes';
import { selectBoundedDiscoveryMarkets } from '../../handlers/exchange';
import { SingleFlightCoalescer } from '../cache/SingleFlightCoalescer';
import { LruTtlCache } from '../cache/LruTtlCache';
import { CandleValidator } from '../exchange/CandleValidator';
import { StructuredLogger } from '../telemetry/Telemetry';

/**
 * PublicMarketDataService:
 * Unified 3-tier public market data service.
 *
 * Tier 1: Local isolate memory cache (LruTtlCache) + SingleFlightCoalescer.
 * Tier 2: Cloudflare Workers Cache API (caches.default, cross-isolate regional cache in Frankfurt).
 * Tier 3: Environment-scoped PublicMarketDataCoordinator Durable Object (when env.PUBLIC_MARKET_COORDINATOR is bound).
 * Fallback: Anonymous direct provider with isolated MultiTimeframeCandleStore (unit test & local mode).
 */
export class PublicMarketDataService {
  private static instance: PublicMarketDataService;
  private readonly logger = new StructuredLogger();
  private readonly coalescer = new SingleFlightCoalescer<any>();

  // L1 In-Isolate Memory Caches
  private readonly marketsCache = new LruTtlCache<string, any[]>(50, 5 * 60 * 1000); // 5m
  private readonly tickersCache = new LruTtlCache<string, any[]>(50, 3 * 1000); // 3s
  private readonly tickerMapCache = new LruTtlCache<string, Map<string, any>>(50, 3 * 1000);
  private readonly klinesCache = new LruTtlCache<string, any[]>(500, 15 * 1000); // 15s
  private readonly opportunitiesCache = new LruTtlCache<string, ScannerScanResult>(50, 30 * 1000); // 30s
  private readonly candleStorePool = new Map<string, MultiTimeframeCandleStore>();

  private constructor() {}

  public static getInstance(): PublicMarketDataService {
    if (!PublicMarketDataService.instance) {
      PublicMarketDataService.instance = new PublicMarketDataService();
    }
    return PublicMarketDataService.instance;
  }

  public clearCaches(): void {
    this.marketsCache.clear();
    this.tickersCache.clear();
    this.tickerMapCache.clear();
    this.klinesCache.clear();
    this.opportunitiesCache.clear();
    this.candleStorePool.clear();
    this.coalescer.clear();
  }

  public getOrCreateCandleStore(key: string, provider: any, depth: number = 70): MultiTimeframeCandleStore {
    let store = this.candleStorePool.get(key);
    if (!store) {
      store = new MultiTimeframeCandleStore(provider, depth);
      this.candleStorePool.set(key, store);
    }
    return store;
  }

  private getL2CacheKey(resource: string, exchange: string, env: string, region: string, extra?: string): string {
    const extraPart = extra ? `/${encodeURIComponent(extra)}` : '';
    return `https://public-market-cache.cryptopulse.internal/${exchange}/${env}/${region}/${resource}${extraPart}`;
  }

  private async readL2Cache<T>(url: string): Promise<T | null> {
    try {
      if (typeof caches !== 'undefined' && (caches as any).default) {
        const cache = (caches as any).default;
        const resp = await cache.match(new Request(url));
        if (resp && resp.ok) {
          return await resp.json() as T;
        }
      }
    } catch (_) {}
    return null;
  }

  private async writeL2Cache(url: string, data: any, ttlSeconds: number): Promise<void> {
    try {
      if (typeof caches !== 'undefined' && (caches as any).default) {
        const cache = (caches as any).default;
        const resp = new Response(JSON.stringify(data), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${ttlSeconds}`,
          },
        });
        await cache.put(new Request(url), resp);
      }
    } catch (_) {}
  }

  public async getMarkets(
    env: Env,
    exchange: ExchangeName = 'bybit',
    environment: ExchangeEnvironment = 'mainnet',
    region: ExchangeRegion = 'india'
  ): Promise<any[]> {
    const l1Key = `${exchange}:${environment}:${region}:markets`;

    // Tier 1: L1 Memory
    const l1Cached = this.marketsCache.get(l1Key);
    if (l1Cached) return l1Cached;

    return this.coalescer.do(l1Key, async () => {
      const freshL1 = this.marketsCache.get(l1Key);
      if (freshL1) return freshL1;

      // Tier 2: L2 Edge Cache
      const l2Url = this.getL2CacheKey('markets', exchange, environment, region);
      const l2Cached = await this.readL2Cache<any[]>(l2Url);
      if (l2Cached && Array.isArray(l2Cached) && l2Cached.length > 0) {
        this.marketsCache.set(l1Key, l2Cached);
        return l2Cached;
      }

      // Tier 3: L3 Coordinator DO (if bound)
      if (env.PUBLIC_MARKET_COORDINATOR && typeof env.PUBLIC_MARKET_COORDINATOR.idFromName === 'function') {
        try {
          const doId = env.PUBLIC_MARKET_COORDINATOR.idFromName(`${exchange}:${environment}:${region}`);
          const coordinator = env.PUBLIC_MARKET_COORDINATOR.get(doId);
          const resp = await coordinator.fetch(new Request('http://coordinator/markets'));
          if (resp.ok) {
            const data = await resp.json() as any[];
            this.marketsCache.set(l1Key, data);
            await this.writeL2Cache(l2Url, data, 300); // 5m L2 TTL
            return data;
          }
        } catch (err: any) {
          this.logger.warn('[PublicMarketDataService] Coordinator /markets failed, falling back to direct adapter:', err?.message);
        }
      }

      // Fallback: Direct anonymous CCXT adapter
      const adapter = await ExchangeManager.getProvider(exchange, { environment, region });
      const markets = await adapter.fetchMarkets();
      this.marketsCache.set(l1Key, markets);
      await this.writeL2Cache(l2Url, markets, 300);
      return markets;
    });
  }

  public async getTickers(
    env: Env,
    exchange: ExchangeName = 'bybit',
    environment: ExchangeEnvironment = 'mainnet',
    region: ExchangeRegion = 'india'
  ): Promise<any[]> {
    const l1Key = `${exchange}:${environment}:${region}:tickers`;

    // Tier 1: L1 Memory
    const l1Cached = this.tickersCache.get(l1Key);
    if (l1Cached) return l1Cached;

    return this.coalescer.do(l1Key, async () => {
      const freshL1 = this.tickersCache.get(l1Key);
      if (freshL1) return freshL1;

      // Tier 2: L2 Edge Cache
      const l2Url = this.getL2CacheKey('tickers', exchange, environment, region);
      const l2Cached = await this.readL2Cache<any[]>(l2Url);
      if (l2Cached && Array.isArray(l2Cached) && l2Cached.length > 0) {
        this.cacheTickersInL1(l1Key, l2Cached);
        return l2Cached;
      }

      // Tier 3: L3 Coordinator DO (if bound)
      if (env.PUBLIC_MARKET_COORDINATOR && typeof env.PUBLIC_MARKET_COORDINATOR.idFromName === 'function') {
        try {
          const doId = env.PUBLIC_MARKET_COORDINATOR.idFromName(`${exchange}:${environment}:${region}`);
          const coordinator = env.PUBLIC_MARKET_COORDINATOR.get(doId);
          const resp = await coordinator.fetch(new Request('http://coordinator/tickers'));
          if (resp.ok) {
            const data = await resp.json() as any[];
            this.cacheTickersInL1(l1Key, data);
            await this.writeL2Cache(l2Url, data, 3); // 3s L2 TTL
            return data;
          }
        } catch (err: any) {
          this.logger.warn('[PublicMarketDataService] Coordinator /tickers failed, falling back to direct adapter:', err?.message);
        }
      }

      // Fallback: Direct anonymous CCXT adapter
      const adapter = await ExchangeManager.getProvider(exchange, { environment, region });
      const tickers = await adapter.fetchTickers();
      this.cacheTickersInL1(l1Key, tickers);
      await this.writeL2Cache(l2Url, tickers, 3);
      return tickers;
    });
  }

  private cacheTickersInL1(l1Key: string, tickers: any[]): void {
    this.tickersCache.set(l1Key, tickers);
    const map = new Map<string, any>();
    for (const t of tickers) {
      if (t.symbol) map.set(t.symbol, t);
      if (t.id) map.set(t.id, t);
      if (t.pairName) map.set(t.pairName, t);
    }
    this.tickerMapCache.set(l1Key, map);
  }

  public async getSingleTicker(
    env: Env,
    symbol: string,
    exchange: ExchangeName = 'bybit',
    environment: ExchangeEnvironment = 'mainnet',
    region: ExchangeRegion = 'india'
  ): Promise<any | null> {
    const l1Key = `${exchange}:${environment}:${region}:tickers`;
    const map = this.tickerMapCache.get(l1Key);
    if (map) {
      const match = map.get(symbol);
      if (match) return match;
    }

    // Tier 1 / Tier 2 Ticker Fetch
    const tickers = await this.getTickers(env, exchange, environment, region);
    const freshMap = this.tickerMapCache.get(l1Key);
    if (freshMap) {
      const match = freshMap.get(symbol);
      if (match) return match;
    }

    return tickers.find((t: any) => t.symbol === symbol || t.pairName === symbol) || null;
  }

  public async getKlines(
    env: Env,
    symbol: string,
    interval: string = '5m',
    limit: number = 100,
    exchange: ExchangeName = 'bybit',
    environment: ExchangeEnvironment = 'mainnet',
    region: ExchangeRegion = 'india'
  ): Promise<any[]> {
    const l1Key = `${exchange}:${environment}:${region}:klines:${symbol}:${interval}`;

    // Tier 1: L1 Memory
    const l1Cached = this.klinesCache.get(l1Key);
    if (l1Cached && l1Cached.length >= limit) {
      return l1Cached.slice(-limit);
    }

    return this.coalescer.do(l1Key, async () => {
      const freshL1 = this.klinesCache.get(l1Key);
      if (freshL1 && freshL1.length >= limit) {
        return freshL1.slice(-limit);
      }

      // Tier 2: L2 Edge Cache
      const l2Url = this.getL2CacheKey(`klines/${encodeURIComponent(symbol)}/${interval}`, exchange, environment, region);
      const l2Cached = await this.readL2Cache<any[]>(l2Url);
      if (l2Cached && Array.isArray(l2Cached) && l2Cached.length >= limit) {
        this.klinesCache.set(l1Key, l2Cached);
        return l2Cached.slice(-limit);
      }

      // Tier 3: L3 Coordinator DO (if bound)
      if (env.PUBLIC_MARKET_COORDINATOR && typeof env.PUBLIC_MARKET_COORDINATOR.idFromName === 'function') {
        try {
          const doId = env.PUBLIC_MARKET_COORDINATOR.idFromName(`${exchange}:${environment}:${region}`);
          const coordinator = env.PUBLIC_MARKET_COORDINATOR.get(doId);
          const resp = await coordinator.fetch(
            new Request(`http://coordinator/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=205`)
          );
          if (resp.ok) {
            const data = await resp.json() as any[];
            this.klinesCache.set(l1Key, data);
            await this.writeL2Cache(l2Url, data, 15); // 15s L2 TTL
            return data.slice(-limit);
          }
        } catch (err: any) {
          this.logger.warn('[PublicMarketDataService] Coordinator /klines failed, falling back to direct adapter:', err?.message);
        }
      }

      // Fallback: Direct anonymous CCXT adapter
      const adapter = await ExchangeManager.getProvider(exchange, { environment, region });
      const fetchLimit = Math.max(limit, 205);
      const rawKlines = await adapter.fetchKlines(symbol, interval, fetchLimit);
      const clean = CandleValidator.sanitizeAndSortCandles(rawKlines);
      this.klinesCache.set(l1Key, clean);
      await this.writeL2Cache(l2Url, clean, 15);
      return clean.slice(-limit);
    });
  }

  public async getOpportunities(
    env: Env,
    exchange: ExchangeName = 'bybit',
    environment: ExchangeEnvironment = 'mainnet',
    region: ExchangeRegion = 'india'
  ): Promise<ScannerScanResult> {
    const l1Key = `${exchange}:${environment}:${region}:opportunities`;

    // Tier 1: L1 Memory
    const l1Cached = this.opportunitiesCache.get(l1Key);
    if (l1Cached) return l1Cached;

    return this.coalescer.do(l1Key, async () => {
      const freshL1 = this.opportunitiesCache.get(l1Key);
      if (freshL1) return freshL1;

      // Tier 2: L2 Edge Cache
      const l2Url = this.getL2CacheKey('opportunities', exchange, environment, region);
      const l2Cached = await this.readL2Cache<ScannerScanResult>(l2Url);
      if (l2Cached && l2Cached.allQualifiedOpportunities) {
        this.opportunitiesCache.set(l1Key, l2Cached);
        return l2Cached;
      }

      // Tier 3: L3 Coordinator DO (if bound)
      if (env.PUBLIC_MARKET_COORDINATOR && typeof env.PUBLIC_MARKET_COORDINATOR.idFromName === 'function') {
        try {
          const doId = env.PUBLIC_MARKET_COORDINATOR.idFromName(`${exchange}:${environment}:${region}`);
          const coordinator = env.PUBLIC_MARKET_COORDINATOR.get(doId);
          const resp = await coordinator.fetch(new Request('http://coordinator/opportunities'));
          if (resp.ok) {
            const data = await resp.json() as ScannerScanResult;
            if (data && data.screenedCount > 0) {
              this.opportunitiesCache.set(l1Key, data);
              await this.writeL2Cache(l2Url, data, 30); // 30s L2 TTL
              return data;
            }
          }
        } catch (err: any) {
          this.logger.warn('[PublicMarketDataService] Coordinator /opportunities failed, falling back to direct scan:', err?.message);
        }
      }

      // Fallback: Direct anonymous scan
      const adapter = await ExchangeManager.getProvider(exchange, { environment, region });
      const [markets, tickers] = await Promise.all([
        this.getMarkets(env, exchange, environment, region),
        this.getTickers(env, exchange, environment, region),
      ]);
      const boundedMarkets = selectBoundedDiscoveryMarkets(markets, tickers, null, 8);

      if (boundedMarkets.length === 0) {
        const emptyResult: ScannerScanResult = {
          timestamp: Date.now(),
          executionDurationMs: 0,
          universeSize: markets.length,
          eligibleCount: 0,
          qualityCount: 0,
          screenedCount: 0,
          allQualifiedOpportunities: [],
          topOpportunities: [],
          telemetry: {} as any,
        };
        return emptyResult;
      }

      const candleStoreKey = `${exchange}:${environment}:${region}:cd70`;
      const candleStore = this.getOrCreateCandleStore(candleStoreKey, adapter, 70);
      const scanner = new MarketOpportunityScanner(adapter as any, DEFAULT_SCANNER_CONFIG, candleStore);
      const result = await scanner.scan({ markets: boundedMarkets, tickers });

      if (
        result &&
        result.screenedCount > 0 &&
        (!result.allQualifiedOpportunities || !result.allQualifiedOpportunities.every((o: any) => o.state === 'DATA_DEGRADED'))
      ) {
        this.opportunitiesCache.set(l1Key, result);
        await this.writeL2Cache(l2Url, result, 30);
      }

      return result;
    });
  }
}
