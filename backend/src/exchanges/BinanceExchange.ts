import { IExchangeAdapter, ValidationResult, MarketTicker, OrderResult, Kline } from "./BaseExchange";
import { ExchangeConfig, ExchangeEnvironment, ExchangeRegion, SymbolMetadata } from "./types";
import { classifyExchangeResponse, classifyException, classifyByBody, type ClassifiedError } from "./errors";

async function hmacSha256(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeKlineInterval(interval: string): string {
  const map: Record<string, string> = {
    "1": "1m",
    "3": "3m",
    "5": "5m",
    "15": "15m",
    "30": "30m",
    "60": "1h",
    "120": "2h",
    "240": "4h",
    "360": "6h",
    "720": "12h",
    "D": "1d",
    "W": "1w",
    "M": "1M",
  };
  return map[interval] ?? interval;
}

export class BinanceExchange implements IExchangeAdapter {
  readonly config: ExchangeConfig = {
    name: "binance",
    displayName: "Binance",
    defaultRegion: "global",
    regionUrls: {
      global: "https://api.binance.com",
      india: "https://api.binance.com",
    },
    regionTestnetUrls: {
      global: "https://testnet.binance.vision",
      india: "https://testnet.binance.vision",
    },
  };

  private environment: ExchangeEnvironment = "mainnet";
  private region: ExchangeRegion = "global";

  // Cache state properties
  private metadataCache: Map<string, SymbolMetadata> | null = null;
  private lastCacheFetch = 0;
  private cacheFetchPromise: Promise<Map<string, SymbolMetadata>> | null = null;

  // Cache observability metrics
  public cacheMetrics = {
    hits: 0,
    misses: 0,
    refreshes: 0,
    failures: 0,
    staleUsage: 0,
  };

  // Helper with exponential backoff retries
  private async fetchWithRetry(url: string, retries = 2, delay = 500): Promise<Response> {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        const res = await fetch(url);
        if (res.ok) return res;
        throw new Error(`HTTP status ${res.status}`);
      } catch (err) {
        if (attempt > retries) throw err;
        await new Promise((resolve) => setTimeout(resolve, delay * Math.pow(2, attempt - 1)));
      }
    }
    throw new Error("Fetch failed after retries");
  }

  private async fetchExchangeMetadata(): Promise<Map<string, SymbolMetadata>> {
    this.cacheMetrics.refreshes++;
    const response = await this.fetchWithRetry(`${this.getRestUrl()}/api/v3/exchangeInfo`);
    const data = await response.json() as any;
    const map = new Map<string, SymbolMetadata>();
    for (const symbol of data.symbols ?? []) {
      const filters = symbol.filters ?? [];
      const lotFilter = filters.find((f: any) => f.filterType === "LOT_SIZE");
      const priceFilter = filters.find((f: any) => f.filterType === "PRICE_FILTER");
      const notionalFilter = filters.find((f: any) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
      if (lotFilter && symbol.status === "TRADING") {
        const parsedMinNotional = notionalFilter ? parseFloat(notionalFilter.minNotional || notionalFilter.minVal || "5.0") : 5.0;
        map.set(symbol.symbol, {
          minQty: parseFloat(lotFilter.minQty || "0.001"),
          maxQty: parseFloat(lotFilter.maxQty || "999999999"),
          tickSize: parseFloat(priceFilter?.tickSize || "0.01"),
          lotSize: parseFloat(lotFilter.stepSize || "1"),
          minNotional: parsedMinNotional > 0 ? parsedMinNotional : 5.0,
        });
      }
    }
    console.log(`[Binance] Metadata successfully loaded: ${map.size} symbols.`);
    return map;
  }

  private async getSymbolMetadata(symbol: string): Promise<SymbolMetadata | null> {
    const fullSymbol = `${symbol.toUpperCase()}USDT`;
    const now = Date.now();
    const expiryLimit = 1800000; // 30 minutes
    const hasCache = this.metadataCache !== null;
    const isExpired = now - this.lastCacheFetch > expiryLimit;

    // Hit vs Miss metrics tracking
    if (hasCache && this.metadataCache!.has(fullSymbol)) {
      this.cacheMetrics.hits++;
    } else {
      this.cacheMetrics.misses++;
    }

    // 1. Stale-while-revalidate logic
    if (isExpired && hasCache) {
      this.cacheMetrics.staleUsage++;
      if (!this.cacheFetchPromise) {
        this.cacheFetchPromise = (async () => {
          try {
            const freshMap = await this.fetchExchangeMetadata();
            this.metadataCache = freshMap;
            this.lastCacheFetch = Date.now();
            return freshMap;
          } catch (err) {
            this.cacheMetrics.failures++;
            console.error("[Binance] Background cache refresh failed, keeping existing cache:", err);
            this.lastCacheFetch = Date.now() - 1500000; // retry in 5 minutes
            return this.metadataCache!;
          } finally {
            this.cacheFetchPromise = null;
          }
        })();
      }
      return this.metadataCache!.get(fullSymbol) ?? null;
    }

    // 2. Cold start / empty cache logic
    if (!hasCache) {
      if (!this.cacheFetchPromise) {
        this.cacheFetchPromise = (async () => {
          try {
            const freshMap = await this.fetchExchangeMetadata();
            this.metadataCache = freshMap;
            this.lastCacheFetch = Date.now();
            return freshMap;
          } catch (err) {
            this.cacheMetrics.failures++;
            this.cacheFetchPromise = null;
            throw err;
          } finally {
            this.cacheFetchPromise = null;
          }
        })();
      }
      try {
        await this.cacheFetchPromise;
      } catch (err) {
        console.error("[Binance] Cold-start metadata download failed:", err);
      }
    }

    return this.metadataCache?.get(fullSymbol) ?? null;
  }

  getName() {
    return this.config.displayName;
  }

  setEnvironment(environment: ExchangeEnvironment) {
    this.environment = environment;
  }

  setRegion(region: ExchangeRegion) {
    this.region = region;
  }

  getRestUrl(): string {
    const urls = this.config.regionUrls;
    const testnet = this.config.regionTestnetUrls;
    if (this.environment === "testnet" && testnet && testnet[this.region]) {
      return testnet[this.region]!;
    }
    return urls[this.region] ?? urls.global;
  }

  async validateCredentials(apiKey: string, apiSecret: string): Promise<ValidationResult> {
    try {
      const timestamp = Date.now();
      const query = `timestamp=${timestamp}`;
      const signature = await hmacSha256(query, apiSecret);
      const url = `${this.getRestUrl()}/api/v3/account?${query}&signature=${signature}`;

      const response = await fetch(url, {
        headers: {
          "X-MBX-APIKEY": apiKey,
        },
      });

      if (!response.ok) {
        const body = await response.text();
        const err: ClassifiedError = classifyExchangeResponse(response.status, body, this.config.displayName);
        return { success: false, message: err.technicalDetail, code: err.code, friendlyMessage: err.friendlyMessage };
      }

      const data = await response.json() as any;
      if (data.code && data.code !== 0) {
        const detail = data.msg || "Invalid API credentials";
        const err: ClassifiedError = classifyByBody(detail, this.config.displayName);
        return { success: false, message: `${err.code}: ${detail}`, code: err.code, friendlyMessage: err.friendlyMessage };
      }

      if (data.canTrade === false) {
        return {
          success: false,
          message: "SPOT_TRADING_NOT_ENABLED: API key lacks spot trade permission",
          code: "SPOT_TRADING_NOT_ENABLED",
          friendlyMessage: "Spot trading is not enabled on this API key. Go to your exchange API settings and check the 'Enable Spot Trading' permission."
        };
      }

      return { success: true, message: "Binance credentials validated successfully" };
    } catch (e: any) {
      const err = classifyException(e, this.config.displayName);
      return { success: false, message: err.technicalDetail, code: err.code, friendlyMessage: err.friendlyMessage };
    }
  }

  async fetchMarketData(): Promise<MarketTicker[]> {
    try {
      const [tickersResponse] = await Promise.all([
        fetch(`${this.getRestUrl()}/api/v3/ticker/24hr`),
        this.getSymbolMetadata("BTC"), // Seed cache if cold
      ]);

      if (!tickersResponse.ok) {
        return [];
      }

      const tickers = await tickersResponse.json() as any[];
      return tickers
        .filter((item: any) => item.symbol.endsWith("USDT") || item.symbol.endsWith("BUSD"))
        .slice(0, 50)
        .map((item: any) => {
          const lot = this.metadataCache?.get(item.symbol) ?? { minQty: 0.001, maxQty: 999999999, tickSize: 0.01, lotSize: 1 };
          return {
            symbol: item.symbol.replace(/USDT|BUSD$/, ""),
            price: parseFloat(item.lastPrice),
            volume24h: parseFloat(item.volume),
            quoteVolume24h: parseFloat(item.quoteVolume || item.volume * item.lastPrice || 0),
            priceChange24h: parseFloat(item.priceChange),
            priceChangePercent24h: parseFloat(item.priceChangePercent),
            highPrice24h: parseFloat(item.highPrice),
            lowPrice24h: parseFloat(item.lowPrice),
            minNotional: lot.minNotional ?? (lot.minQty * (parseFloat(item.lastPrice) || 1)),
            minOrderQty: lot.minQty,
            maxOrderQty: lot.maxQty,
            tickSize: lot.tickSize,
            lotSize: lot.lotSize,
          };
        });
    } catch {
      return [];
    }
  }

  async fetchTicker(symbol: string): Promise<MarketTicker | null> {
    try {
      if (!/^[A-Za-z0-9]+$/.test(symbol)) {
        return null;
      }
      const [response, lot] = await Promise.all([
        fetch(`${this.getRestUrl()}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol.toUpperCase())}USDT`),
        this.getSymbolMetadata(symbol),
      ]);
      if (!response.ok) return null;
      const item = (await response.json()) as any;
      if (!item || !item.symbol) return null;

      const lotResolved = lot ?? { minQty: 0.001, maxQty: 999999999, tickSize: 0.01, lotSize: 1 };
      return {
        symbol: item.symbol.replace(/USDT|BUSD$/, ""),
        price: parseFloat(item.lastPrice || 0),
        volume24h: parseFloat(item.volume || 0),
        quoteVolume24h: parseFloat(item.quoteVolume || (item.volume * item.lastPrice) || 0),
        priceChange24h: parseFloat(item.priceChange || 0),
        priceChangePercent24h: parseFloat(item.priceChangePercent || 0),
        highPrice24h: parseFloat(item.highPrice || 0),
        lowPrice24h: parseFloat(item.lowPrice || 0),
        minNotional: lotResolved.minNotional ?? (lotResolved.minQty * (parseFloat(item.lastPrice || 0) || 1)),
        minOrderQty: lotResolved.minQty,
        maxOrderQty: lotResolved.maxQty,
        tickSize: lotResolved.tickSize,
        lotSize: lotResolved.lotSize,
      };
    } catch {
      return null;
    }
  }

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    try {
      const params = new URLSearchParams({
        symbol: `${symbol.toUpperCase()}USDT`,
        interval: normalizeKlineInterval(interval),
        limit: limit.toString(),
      });
      const response = await fetch(`${this.getRestUrl()}/api/v3/klines?${params}`);
      if (!response.ok) return [];
      const data = (await response.json()) as any[];
      return data.map((k: any[]) => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
      }));
    } catch {
      return [];
    }
  }

  async placeOrder(symbol: string, side: 'BUY' | 'SELL', apiKey: string, apiSecret: string, quantity?: number): Promise<OrderResult> {
    try {
      const timestamp = Date.now();
      const recvWindow = 5000;
      const fullSymbol = `${symbol.toUpperCase()}USDT`;
      const qty = quantity ?? 10;
      
      const orderParams = new URLSearchParams({
        symbol: fullSymbol,
        side: side,
        type: 'MARKET',
        quantity: qty.toString(),
        timestamp: timestamp.toString(),
        recvWindow: recvWindow.toString(),
      });

      const signature = await hmacSha256(orderParams.toString(), apiSecret);
      const url = `${this.getRestUrl()}/api/v3/order?signature=${signature}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: orderParams.toString(),
      });

      const data = await response.json() as any;
      
      if (!response.ok || data.code) {
        const detail = data.msg || `HTTP ${response.status}: Order failed`;
        const err: ClassifiedError = classifyByBody(detail, this.config.displayName);
        return { success: false, message: `${err.code}: ${detail}`, code: err.code, friendlyMessage: err.friendlyMessage };
      }

      return {
        success: true,
        message: `Order placed successfully`,
        orderId: data.orderId?.toString(),
        price: parseFloat(data.fills?.[0]?.price || '0'),
        quantity: parseFloat(data.fills?.[0]?.qty || qty.toString()),
      };
    } catch (e: any) {
      const err = classifyException(e, this.config.displayName);
      return { success: false, message: err.technicalDetail, code: err.code, friendlyMessage: err.friendlyMessage };
    }
  }
}
