import { Env } from '../../index';
import { ExchangeManager, ExchangeName, ExchangeEnvironment, ExchangeRegion } from '../../exchanges';
import { normalizeEnvironment } from '../../utils/environment';
import { resolveCanonicalRoutingRegion } from '../../utils/region';
import { MultiTimeframeCandleStore, ScannerTimeframe } from '../../engine/scanner/MultiTimeframeCandleStore';
import { MarketOpportunityScanner, ScannerScanResult } from '../../engine/scanner/MarketOpportunityScanner';
import { DEFAULT_SCANNER_CONFIG } from '../../engine/scanner/ScannerTypes';
import { selectBoundedDiscoveryMarkets } from '../../handlers/exchange';
import { ExchangeRequestScheduler, InMemorySchedulerStorage } from '../exchange/pacing';
import { SingleFlightCoalescer } from '../cache/SingleFlightCoalescer';
import { LruTtlCache } from '../cache/LruTtlCache';
import { CandleValidator } from '../exchange/CandleValidator';
import { StructuredLogger } from '../telemetry/Telemetry';

/**
 * PublicMarketDataCoordinator:
 * Durable Object coordinating public market data fetching (markets, tickers, klines, opportunities)
 * per exchange environment and region (e.g., 'bybit:mainnet:aws-eu-central-1').
 *
 * Invariant: Operates 100% anonymously with public endpoints. Stores 0 user credentials,
 * performs 0 private account queries, and uses InMemorySchedulerStorage (0 SQLite row writes).
 */
export class PublicMarketDataCoordinator {
  private readonly logger = new StructuredLogger();
  private readonly scheduler = new ExchangeRequestScheduler(new InMemorySchedulerStorage());
  private readonly coalescer = new SingleFlightCoalescer<any>();
  private readonly candleStore: MultiTimeframeCandleStore;

  private cachedMarkets: { data: any[]; timestamp: number } | null = null;
  private readonly MARKETS_TTL_MS = 5 * 60 * 1000; // 5 minutes

  private cachedTickers: { data: any[]; tickerMap: Map<string, any>; timestamp: number } | null = null;
  private readonly TICKERS_TTL_MS = 3 * 1000; // 3 seconds

  private readonly klineCache = new LruTtlCache<string, any[]>(500, 15 * 1000); // 15 seconds
  private cachedOpportunities: { data: ScannerScanResult; timestamp: number } | null = null;
  private readonly OPPORTUNITY_TTL_MS = 30 * 1000; // 30 seconds

  private exchangeName: ExchangeName = 'bybit';
  private environment: ExchangeEnvironment = 'mainnet';
  private region: ExchangeRegion = 'india';
  private adapterPromise: Promise<any> | null = null;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    // 205 bars buffer covers EMA-200 + safe margin for TradingBot, TA preview, and scanner
    const dummyProvider = {
      fetchCandles: async (sym: string, tf: string, limit: number) => this.fetchUpstreamKlines(sym, tf, limit),
      fetchKlines: async (sym: string, tf: string, limit: number) => this.fetchUpstreamKlines(sym, tf, limit),
    };
    this.candleStore = new MultiTimeframeCandleStore(dummyProvider as any, 205, this.scheduler);
  }

  private async getAdapter(): Promise<any> {
    if (!this.adapterPromise) {
      this.adapterPromise = ExchangeManager.getProvider(this.exchangeName, {
        environment: this.environment,
        region: this.region,
      });
    }
    return this.adapterPromise;
  }

  private async fetchUpstreamKlines(symbol: string, timeframe: string, limit: number = 205): Promise<any[]> {
    const adapter = await this.getAdapter();
    const fetchLimit = Math.max(limit, 205);
    const klines = await adapter.fetchKlines(symbol, timeframe, fetchLimit);
    return CandleValidator.sanitizeAndSortCandles(klines);
  }

  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Optional environment overrides via headers or query params
    const envParam = url.searchParams.get('environment') || request.headers.get('x-exchange-environment');
    if (envParam) {
      const normEnv = normalizeEnvironment(envParam);
      if (normEnv) this.environment = normEnv;
    }
    const regionParam = url.searchParams.get('region') || request.headers.get('x-exchange-region');
    if (regionParam) {
      this.region = resolveCanonicalRoutingRegion(regionParam);
    }

    try {
      switch (path) {
        case '/markets': {
          const markets = await this.getMarkets();
          return Response.json(markets);
        }

        case '/tickers': {
          const tickers = await this.getTickers();
          return Response.json(tickers);
        }

        case '/ticker': {
          const symbol = url.searchParams.get('symbol');
          if (!symbol) {
            return Response.json({ error: 'symbol query parameter required' }, { status: 400 });
          }
          const ticker = await this.getSingleTicker(symbol);
          if (!ticker) {
            return Response.json({ error: `Ticker for ${symbol} not found` }, { status: 404 });
          }
          return Response.json(ticker);
        }

        case '/klines': {
          const symbol = url.searchParams.get('symbol');
          const interval = url.searchParams.get('interval') || url.searchParams.get('timeframe') || '5m';
          const limitStr = url.searchParams.get('limit') || '100';
          const limit = Math.min(parseInt(limitStr, 10) || 100, 205);

          if (!symbol) {
            return Response.json({ error: 'symbol query parameter required' }, { status: 400 });
          }
          const klines = await this.getKlines(symbol, interval, limit);
          return Response.json(klines);
        }

        case '/opportunities': {
          const opportunities = await this.getOpportunities();
          return Response.json(opportunities);
        }

        case '/stats': {
          return Response.json({
            exchangeName: this.exchangeName,
            environment: this.environment,
            region: this.region,
            marketsCached: this.cachedMarkets !== null,
            tickersCached: this.cachedTickers !== null,
            klineCacheSize: this.klineCache.size(),
            candleStoreSize: this.candleStore.size(),
            opportunitiesCached: this.cachedOpportunities !== null,
            coalescerStats: this.coalescer.getStats(),
          });
        }

        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (err: any) {
      this.logger.error(`[PublicMarketDataCoordinator] Error handling ${path}:`, err);
      return Response.json({ error: err?.message || String(err) }, { status: 500 });
    }
  }

  public async getMarkets(): Promise<any[]> {
    if (this.cachedMarkets && Date.now() - this.cachedMarkets.timestamp < this.MARKETS_TTL_MS) {
      return this.cachedMarkets.data;
    }

    return this.coalescer.do('markets', async () => {
      if (this.cachedMarkets && Date.now() - this.cachedMarkets.timestamp < this.MARKETS_TTL_MS) {
        return this.cachedMarkets.data;
      }
      const adapter = await this.getAdapter();
      const markets = await adapter.fetchMarkets();
      this.cachedMarkets = { data: markets, timestamp: Date.now() };
      return markets;
    });
  }

  public async getTickers(): Promise<any[]> {
    if (this.cachedTickers && Date.now() - this.cachedTickers.timestamp < this.TICKERS_TTL_MS) {
      return this.cachedTickers.data;
    }

    return this.coalescer.do('tickers', async () => {
      if (this.cachedTickers && Date.now() - this.cachedTickers.timestamp < this.TICKERS_TTL_MS) {
        return this.cachedTickers.data;
      }
      const adapter = await this.getAdapter();
      const rawTickers = await adapter.fetchTickers();
      const tickerMap = new Map<string, any>();
      for (const t of rawTickers) {
        if (t.symbol) tickerMap.set(t.symbol, t);
        if (t.id) tickerMap.set(t.id, t);
        if (t.pairName) tickerMap.set(t.pairName, t);
      }
      this.cachedTickers = { data: rawTickers, tickerMap, timestamp: Date.now() };
      return rawTickers;
    });
  }

  public async getSingleTicker(symbol: string): Promise<any | null> {
    if (this.cachedTickers && Date.now() - this.cachedTickers.timestamp < this.TICKERS_TTL_MS) {
      const match = this.cachedTickers.tickerMap.get(symbol);
      if (match) return match;
    }
    const tickers = await this.getTickers();
    if (this.cachedTickers) {
      return this.cachedTickers.tickerMap.get(symbol) || null;
    }
    return tickers.find((t: any) => t.symbol === symbol || t.pairName === symbol) || null;
  }

  public async getKlines(symbol: string, timeframe: string, limit: number = 100): Promise<any[]> {
    const cacheKey = `${symbol}:${timeframe}`;
    const cachedSeries = this.klineCache.get(cacheKey);

    if (cachedSeries && cachedSeries.length >= limit) {
      return cachedSeries.slice(-limit);
    }

    return this.coalescer.do(`klines:${cacheKey}`, async () => {
      const freshCheck = this.klineCache.get(cacheKey);
      if (freshCheck && freshCheck.length >= limit) {
        return freshCheck.slice(-limit);
      }

      const fullSeries = await this.fetchUpstreamKlines(symbol, timeframe, 205);
      this.klineCache.set(cacheKey, fullSeries);
      return fullSeries.slice(-limit);
    });
  }

  public async getOpportunities(): Promise<ScannerScanResult> {
    if (this.cachedOpportunities && Date.now() - this.cachedOpportunities.timestamp < this.OPPORTUNITY_TTL_MS) {
      return this.cachedOpportunities.data;
    }

    return this.coalescer.do('opportunities', async () => {
      if (this.cachedOpportunities && Date.now() - this.cachedOpportunities.timestamp < this.OPPORTUNITY_TTL_MS) {
        return this.cachedOpportunities.data;
      }

      const [markets, tickers] = await Promise.all([this.getMarkets(), this.getTickers()]);
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

      const adapter = await this.getAdapter();
      const scanner = new MarketOpportunityScanner(adapter, DEFAULT_SCANNER_CONFIG, this.candleStore);
      const result = await scanner.scan({ markets: boundedMarkets, tickers });

      if (
        result &&
        result.screenedCount > 0 &&
        (!result.allQualifiedOpportunities || !result.allQualifiedOpportunities.every((o: any) => o.state === 'DATA_DEGRADED'))
      ) {
        this.cachedOpportunities = { data: result, timestamp: Date.now() };
      }

      return result;
    });
  }
}
