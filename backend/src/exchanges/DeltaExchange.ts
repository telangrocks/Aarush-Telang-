import { IExchangeAdapter, ValidationResult, MarketTicker, Kline, OrderResult, PositionsResponse, PositionResult } from "./BaseExchange";
import { ExchangeConfig, ExchangeEnvironment, ExchangeRegion, SymbolMetadata } from "./types";
import { classifyExchangeResponse, classifyException, classifyByBody, type ClassifiedError } from "./errors";
import { CircuitBreaker } from "./CircuitBreaker";

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

function normalizeInterval(interval: string): { resolution: string; seconds: number } {
  const map: Record<string, { resolution: string; seconds: number }> = {
    "1": { resolution: "1m", seconds: 60 },
    "1m": { resolution: "1m", seconds: 60 },
    "3": { resolution: "3m", seconds: 180 },
    "3m": { resolution: "3m", seconds: 180 },
    "5": { resolution: "5m", seconds: 300 },
    "5m": { resolution: "5m", seconds: 300 },
    "15": { resolution: "15m", seconds: 900 },
    "15m": { resolution: "15m", seconds: 900 },
    "30": { resolution: "30m", seconds: 1800 },
    "30m": { resolution: "30m", seconds: 1800 },
    "60": { resolution: "1h", seconds: 3600 },
    "1h": { resolution: "1h", seconds: 3600 },
    "120": { resolution: "2h", seconds: 7200 },
    "2h": { resolution: "2h", seconds: 7200 },
    "240": { resolution: "4h", seconds: 14400 },
    "4h": { resolution: "4h", seconds: 14400 },
    "360": { resolution: "6h", seconds: 21600 },
    "6h": { resolution: "6h", seconds: 21600 },
    "720": { resolution: "12h", seconds: 43200 },
    "12h": { resolution: "12h", seconds: 43200 },
    "D": { resolution: "1d", seconds: 86400 },
    "1d": { resolution: "1d", seconds: 86400 },
  };
  return map[interval] ?? { resolution: "1h", seconds: 3600 };
}

export class DeltaExchange implements IExchangeAdapter {
  readonly config: ExchangeConfig = {
    name: "delta",
    displayName: "Delta Exchange",
    // Indian accounts cannot reach the global domain (CloudFront 403), so the
    // default region is "india" which points at api.india.delta.exchange.
    defaultRegion: "india",
    regionUrls: {
      global: "https://api.delta.exchange",
      india: "https://api.india.delta.exchange",
    },
    regionTestnetUrls: {
      global: "https://api-testnet.delta.exchange",
      india: "https://cdn-ind.testnet.deltaex.org",
    },
  };

  private environment: ExchangeEnvironment = "mainnet";
  private region: ExchangeRegion = "india";

  // Cache state properties
  private metadataCache: Map<string, SymbolMetadata> | null = null;
  private lastCacheFetch = 0;
  private cacheFetchPromise: Promise<Map<string, SymbolMetadata>> | null = null;
  public breaker = new CircuitBreaker(5, 60000);

  // Cache observability metrics
  public cacheMetrics = {
    hits: 0,
    misses: 0,
    refreshes: 0,
    failures: 0,
    staleUsage: 0,
    circuitBreakerStatus: () => this.breaker.check().allowed ? "CLOSED" : "OPEN",
  };

  // Helper with exponential backoff retries
  private async fetchWithRetry(url: string, options?: RequestInit, retries = 2, delay = 500): Promise<Response> {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        const res = await fetch(url, options);
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
    const response = await this.fetchWithRetry(`${this.getRestUrl()}/v2/products`);
    const data = await response.json() as any;
    if (!data.success || !Array.isArray(data.result)) {
      throw new Error(`Delta API error`);
    }
    const map = new Map<string, SymbolMetadata>();
    for (const product of data.result) {
      const symbol = product.symbol;
      const contractValue = parseFloat(product.contract_value ?? product.min_notional_value ?? "1.0");
      const minQty = contractValue > 0 ? contractValue : 1.0;
      const maxQty = parseFloat(product.max_notional_value ?? product.max_notional ?? "999999999");
      const lotSize = parseFloat(product.lot_size ?? product.step_size ?? "1");
      const tickSize = parseFloat(product.tick_size ?? "0.01");
      if (symbol) {
        map.set(symbol, {
          minQty: minQty,
          maxQty: maxQty > 0 ? maxQty : 999999999,
          tickSize: tickSize > 0 ? tickSize : 0.01,
          lotSize: lotSize > 0 ? lotSize : 1,
          minNotional: minQty,
          id: product.id,
        });
      }
    }
    console.log(`[Delta] Metadata successfully loaded: ${map.size} symbols.`);
    return map;
  }

  private async getSymbolMetadata(symbol: string): Promise<SymbolMetadata | null> {
    const fullSymbol = `${symbol.toUpperCase()}USD`;
    const now = Date.now();
    const expiryLimit = 1800000;
    const hasCache = this.metadataCache !== null;
    const isExpired = now - this.lastCacheFetch > expiryLimit;

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
            console.error("[Delta] Background cache refresh failed, keeping existing cache:", err);
            this.lastCacheFetch = Date.now() - 1500000;
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
        console.error("[Delta] Cold-start metadata download failed:", err);
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
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const requestPath = "/v2/wallet/balances";
      const query = `timestamp=${timestamp}`;
      const prehash = "GET" + timestamp + requestPath + "?" + query;
      const signature = await hmacSha256(prehash, apiSecret);

      const response = await fetch(`${this.getRestUrl()}${requestPath}?${query}`, {
        headers: {
          "api-key": apiKey,
          "signature": signature,
          "timestamp": timestamp,
        },
      });

      if (!response.ok) {
        const body = await response.text();
        const err: ClassifiedError = classifyExchangeResponse(response.status, body, this.config.displayName);
        return { success: false, message: err.technicalDetail, code: err.code, friendlyMessage: err.friendlyMessage };
      }

      const data = await response.json() as any;
      if (data.success === false) {
        const detail = data.error?.message || "Invalid API credentials";
        const err: ClassifiedError = classifyByBody(detail, this.config.displayName);
        return { success: false, message: `${err.code}: ${detail}`, code: err.code, friendlyMessage: err.friendlyMessage };
      }

      return { success: true, message: "Delta Exchange credentials validated successfully" };
    } catch (e: any) {
      const err = classifyException(e, this.config.displayName);
      return { success: false, message: err.technicalDetail, code: err.code, friendlyMessage: err.friendlyMessage };
    }
  }



  async fetchMarketData(): Promise<MarketTicker[]> {
    try {
      const [tickersResponse] = await Promise.all([
        fetch(`${this.getRestUrl()}/v2/tickers`),
        this.getSymbolMetadata("BTC"), // Seed cache if cold
      ]);

      if (!tickersResponse.ok) {
        return [];
      }

      const tickersData = await tickersResponse.json() as any;
      if (!tickersData.success || !Array.isArray(tickersData.result)) {
        return [];
      }

      return tickersData.result
        .filter((item: any) => item.symbol && (item.symbol.includes("USDT") || item.symbol.includes("USDC") || item.symbol.includes("USD")))
        .slice(0, 50)
        .map((item: any) => {
          const lot = this.metadataCache?.get(item.symbol) ?? { minQty: 0.001, maxQty: 999999999, tickSize: 0.01, lotSize: 1 };
          const price = parseFloat(item.close || item.last_price || 0);
          return {
            symbol: item.symbol.replace(/USDT$|USDC$|USD$/, ""),
            price: price,
            volume24h: parseFloat(item.volume || 0),
            quoteVolume24h: parseFloat(item.volume || 0) * price,
            priceChange24h: parseFloat(item.price_change || 0),
            priceChangePercent24h: parseFloat(item.price_change_percent || 0),
            highPrice24h: parseFloat(item.high_24h || item.high || 0),
            lowPrice24h: parseFloat(item.low_24h || item.low || 0),
            minNotional: lot.minQty * (price || 1),
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
        fetch(`${this.getRestUrl()}/v2/tickers/${encodeURIComponent(symbol.toUpperCase())}USD`),
        this.getSymbolMetadata(symbol),
      ]);
      if (!response.ok) return null;
      const data = await response.json() as any;
      const item = data?.result;
      if (!item || !item.symbol) return null;

      const lotResolved = lot ?? { minQty: 0.001, maxQty: 999999999, tickSize: 0.01, lotSize: 1 };
      return {
        symbol: item.symbol.replace(/USDT$|USDC$|USD$/, ""),
        price: parseFloat(item.last_price || item.close || 0),
        volume24h: parseFloat(item.volume || 0),
        quoteVolume24h: parseFloat(item.volume || 0) * parseFloat(item.last_price || item.close || 0),
        priceChange24h: parseFloat(item.change || 0),
        priceChangePercent24h: parseFloat(item.change_percent || 0),
        highPrice24h: parseFloat(item.high || 0),
        lowPrice24h: parseFloat(item.low || 0),
        minNotional: lotResolved.minQty * (parseFloat(item.last_price || item.close || 0) || 1),
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
      const { resolution, seconds } = normalizeInterval(interval);
      const end = Math.floor(Date.now() / 1000);
      const start = end - (limit * seconds);
      const params = new URLSearchParams({
        symbol: `${symbol.toUpperCase()}USD`,
        resolution,
        start: start.toString(),
        end: end.toString(),
      });
      const response = await fetch(`${this.getRestUrl()}/v2/history/candles?${params}`);
      if (!response.ok) return [];
      const data = await response.json() as any;
      if (!data.success || !Array.isArray(data.result)) return [];
      return data.result.map((k: any) => {
        const timeMs = parseInt(k.time) * 1000;
        return {
          openTime: timeMs,
          open: parseFloat(k.open),
          high: parseFloat(k.high),
          low: parseFloat(k.low),
          close: parseFloat(k.close),
          volume: parseFloat(k.volume),
          closeTime: timeMs + (seconds * 1000),
        };
      });
    } catch {
      return [];
    }
  }

  async placeOrder(symbol: string, side: 'BUY' | 'SELL', apiKey: string, apiSecret: string, quantity?: number, clientOrderId?: string): Promise<OrderResult> {
    const breakerState = this.breaker.check();
    if (!breakerState.allowed) {
      return { success: false, message: `Circuit breaker is OPEN. Fast-failing request.`, code: "CIRCUIT_BREAKER_OPEN" };
    }

    try {
      const lot = await this.getSymbolMetadata(symbol);
      if (!lot || !lot.id) {
        return {
          success: false,
          message: `Leverage enforcement failed: Product metadata or ID not found for symbol ${symbol}`,
          code: "LEVERAGE_ENFORCEMENT_FAILED",
          friendlyMessage: "Failed to verify safety limits for this asset. Trade aborted for your protection.",
        };
      }

      try {
        const levTimestamp = Math.floor(Date.now() / 1000).toString();
        const levPath = `/v2/products/${lot.id}/orders/leverage`;
        const levBody = JSON.stringify({ leverage: "1" });
        const levPrehash = "POST" + levTimestamp + levPath + levBody;
        const levSignature = await hmacSha256(levPrehash, apiSecret);
        
        const levRes = await this.fetchWithRetry(`${this.getRestUrl()}${levPath}`, {
          method: "POST",
          headers: {
            "api-key": apiKey,
            "signature": levSignature,
            "timestamp": levTimestamp,
            "Content-Type": "application/json",
          },
          body: levBody,
        });

        if (!levRes.ok) {
          const data = await levRes.json() as any;
          throw new Error(data?.error?.message || `HTTP status ${levRes.status}`);
        }
      } catch (err: any) {
        console.error(`[DeltaExchange] Failed to explicitly enforce 1x leverage:`, err);
        return {
          success: false,
          message: `Leverage enforcement failed: ${err.message || err}`,
          code: "LEVERAGE_ENFORCEMENT_FAILED",
          friendlyMessage: "Failed to safely set leverage to 1x on the exchange. Trade aborted for your protection.",
        };
      }

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const requestPath = "/v2/orders";
      const qty = quantity ?? 0.001;
      const orderPayload: any = {
        symbol: `${symbol.toUpperCase()}USD`,
        side: side === "BUY" ? "buy" : "sell",
        type: "market",
        quantity: qty,
      };
      if (clientOrderId) {
        orderPayload.client_order_id = clientOrderId;
      }
      const body = JSON.stringify(orderPayload);
      const prehash = "POST" + timestamp + requestPath + body;
      const signature = await hmacSha256(prehash, apiSecret);
      const response = await this.fetchWithRetry(`${this.getRestUrl()}${requestPath}`, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "signature": signature,
          "timestamp": timestamp,
          "Content-Type": "application/json",
        },
        body,
      });
      const data = await response.json() as any;
      if (!data.success) {
        this.breaker.recordFailure();
        const detail = data.error?.message || "Order failed";
        const err: ClassifiedError = classifyByBody(detail, this.config.displayName);
        return { success: false, message: `${err.code}: ${detail}`, code: err.code, friendlyMessage: err.friendlyMessage };
      }
      this.breaker.recordSuccess();
      return {
        success: true,
        message: "Order placed successfully",
        orderId: data.result?.id,
        price: parseFloat(data.result?.avg_price || 0),
        quantity: parseFloat(data.result?.quantity || qty.toString()),
      };
    } catch (e: any) {
      this.breaker.recordFailure();
      const err = classifyException(e, this.config.displayName);
      return { success: false, message: err.technicalDetail, code: err.code, friendlyMessage: err.friendlyMessage };
    }
  }

  async fetchPositions(apiKey: string, apiSecret: string): Promise<PositionsResponse> {
    const breakerState = this.breaker.check();
    if (!breakerState.allowed) {
      return { success: false, message: `Circuit breaker is OPEN. Fast-failing request.`, result: [], code: "CIRCUIT_BREAKER_OPEN" };
    }

    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const requestPath = "/v2/positions/margined";
      const prehash = "GET" + timestamp + requestPath;
      const signature = await hmacSha256(prehash, apiSecret);

      const response = await this.fetchWithRetry(`${this.getRestUrl()}${requestPath}`, {
        headers: {
          "api-key": apiKey,
          "signature": signature,
          "timestamp": timestamp,
        },
      });

      if (!response.ok) {
        this.breaker.recordFailure();
        const body = await response.text();
        const err: ClassifiedError = classifyExchangeResponse(response.status, body, this.config.displayName);
        return { success: false, message: err.technicalDetail, result: [], code: err.code, friendlyMessage: err.friendlyMessage };
      }

      const data = await response.json() as any;
      if (data.success === false) {
        this.breaker.recordFailure();
        const detail = data.error?.message || "Failed to fetch positions";
        const err: ClassifiedError = classifyByBody(detail, this.config.displayName);
        return { success: false, message: `${err.code}: ${detail}`, result: [], code: err.code, friendlyMessage: err.friendlyMessage };
      }

      const result: PositionResult[] = data.result?.map((p: any) => ({
        symbol: p.product?.symbol || "",
        size: parseFloat(p.size || "0"),
        entry_price: parseFloat(p.entry_price || "0"),
        unrealized_pnl: parseFloat(p.unrealized_pnl || "0"),
        margin: parseFloat(p.margin || "0"),
      })) || [];

      this.breaker.recordSuccess();
      return { success: true, message: "Positions fetched", result };
    } catch (e: any) {
      this.breaker.recordFailure();
      const err = classifyException(e, this.config.displayName);
      return { success: false, message: err.technicalDetail, result: [], code: err.code, friendlyMessage: err.friendlyMessage };
    }
  }

  async fetchOrder(orderId: string, apiKey: string, apiSecret: string): Promise<OrderResult> {
    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const requestPath = `/v2/orders/${orderId}`;
      const prehash = "GET" + timestamp + requestPath;
      const signature = await hmacSha256(prehash, apiSecret);

      const response = await this.fetchWithRetry(`${this.getRestUrl()}${requestPath}`, {
        headers: {
          "api-key": apiKey,
          "signature": signature,
          "timestamp": timestamp,
        },
      });

      if (!response.ok) {
        const body = await response.text();
        const err: ClassifiedError = classifyExchangeResponse(response.status, body, this.config.displayName);
        return { success: false, message: err.technicalDetail, code: err.code, friendlyMessage: err.friendlyMessage };
      }

      const data = await response.json() as any;
      if (data.success === false) {
        const detail = data.error?.message || "Failed to fetch order";
        const err: ClassifiedError = classifyByBody(detail, this.config.displayName);
        return { success: false, message: `${err.code}: ${detail}`, code: err.code, friendlyMessage: err.friendlyMessage };
      }

      const o = data.result;
      const statusMap: Record<string, any> = {
        'open': 'open',
        'pending': 'pending',
        'closed': 'filled',
        'cancelled': 'cancelled',
        'rejected': 'rejected',
      };

      let status = statusMap[o.state] || o.state;
      if (status === 'open' && parseFloat(o.filled_quantity || "0") > 0 && parseFloat(o.filled_quantity || "0") < parseFloat(o.size || "0")) {
         status = 'partially_filled';
      }

      return {
        success: true,
        message: "Order fetched",
        orderId: o.id,
        price: parseFloat(o.avg_fill_price || o.limit_price || 0),
        quantity: parseFloat(o.size || 0),
        filledQuantity: parseFloat(o.filled_quantity || 0),
        averageFillPrice: parseFloat(o.avg_fill_price || 0),
        status,
      };
    } catch (e: any) {
      const err = classifyException(e, this.config.displayName);
      return { success: false, message: err.technicalDetail, code: err.code, friendlyMessage: err.friendlyMessage };
    }
  }
}
