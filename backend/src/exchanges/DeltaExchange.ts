import { IExchangeAdapter, ValidationResult, MarketTicker, Kline, OrderResult, PositionsResponse, PositionResult, BalanceResponse, BalanceItem } from "./BaseExchange";
import { ExchangeConfig, ExchangeEnvironment, ExchangeRegion, SymbolMetadata } from "./types";
import { classifyExchangeResponse, classifyException, classifyByBody, type ClassifiedError } from "./errors";
import { CircuitBreaker } from "./CircuitBreaker";
import { cleanCredential } from "../crypto";
import { SymbolResolver } from "../utils/SymbolResolver";

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
      if (!product.symbol || (product.trading_status && product.trading_status !== "operational")) continue;

      const contractValue = parseFloat(product.contract_value || "1.0");
      const minQty = parseFloat(product.min_order_qty || "1");
      const maxQty = parseFloat(product.max_order_qty || product.max_notional_value || "999999999");
      const stepSize = parseFloat(product.lot_size || product.step_size || "1");
      const tickSize = parseFloat(product.tick_size || "0.01");
      const minPrice = parseFloat(product.min_price || "0");
      const maxPrice = parseFloat(product.max_price || "999999999");

      const rawNotional = product.min_notional_value ?? product.min_order_value;
      const parsedNotional = rawNotional ? parseFloat(rawNotional) : undefined;
      const minNotional = (parsedNotional && !isNaN(parsedNotional) && parsedNotional > 0)
        ? parsedNotional
        : minQty * contractValue * (minPrice > 0 ? minPrice : 1.0);

      if (isNaN(minQty) || isNaN(stepSize) || isNaN(tickSize)) continue;

      const resolved = SymbolResolver.resolve(product.symbol);
      map.set(resolved.symbol, {
        schemaVersion: "2.0",
        symbol: resolved.symbol,
        exchange: "delta",
        baseAsset: resolved.baseAsset,
        quoteAsset: resolved.quoteAsset,
        minNotional,
        minQty,
        maxQty,
        stepSize,
        tickSize,
        minPrice,
        maxPrice,
        contractSize: contractValue,
        lastUpdated: Date.now(),
        id: product.id,
      });
    }
    console.log(`[Delta] Metadata successfully loaded: ${map.size} symbols.`);
    return map;
  }

  private async getSymbolMetadata(symbol: string): Promise<SymbolMetadata | null> {
    const key = SymbolResolver.toCacheKey(symbol);
    const now = Date.now();
    const expiryLimit = 1800000;
    const hasCache = this.metadataCache !== null;
    const isExpired = now - this.lastCacheFetch > expiryLimit;

    if (hasCache && this.metadataCache!.has(key)) {
      this.cacheMetrics.hits++;
    } else {
      this.cacheMetrics.misses++;
    }

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
      return this.metadataCache!.get(key) ?? null;
    }

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

    return this.metadataCache?.get(key) ?? null;
  }

  getName() {
    return this.config.displayName;
  }

  setEnvironment(environment: ExchangeEnvironment) {
    this.environment = environment;
  }

  getEnvironment(): ExchangeEnvironment {
    return this.environment;
  }

  setRegion(region: ExchangeRegion) {
    this.region = region;
  }

  getRegion(): ExchangeRegion {
    return this.region;
  }

  getRestUrl(): string {
    if (this.environment === "testnet" && this.config.regionTestnetUrls?.[this.region]) {
      return this.config.regionTestnetUrls[this.region]!;
    }
    return this.config.regionUrls[this.region] ?? this.config.regionUrls[this.config.defaultRegion];
  }

  async testConnection(apiKey: string, apiSecret: string): Promise<ValidationResult> {
    try {
      const cleanKey = cleanCredential(apiKey);
      const cleanSec = cleanCredential(apiSecret);

      if (!cleanKey || !cleanSec) {
        return {
          success: false,
          code: "MISSING_CREDENTIALS",
          message: "API key and API secret must be provided.",
          friendlyMessage: "Please enter both your Delta API key and API secret.",
          hint: "Ensure you have copied the full API key and secret from your Delta Exchange API dashboard.",
        };
      }

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const method = "GET";
      const path = "/v2/wallet/balances";
      const signatureData = method + timestamp + path;
      const signature = await hmacSha256(signatureData, cleanSec);

      const response = await fetch(`${this.getRestUrl()}${path}`, {
        method: "GET",
        headers: {
          "api-key": cleanKey,
          "signature": signature,
          "timestamp": timestamp,
          "Content-Type": "application/json",
        },
      });

      const bodyText = await response.text();
      let resData: any = null;
      try {
        resData = JSON.parse(bodyText);
      } catch {
        resData = null;
      }

      if (response.ok && resData && resData.success) {
        return { success: true, message: "Successfully authenticated with Delta Exchange" };
      }

      const classified: ClassifiedError = classifyByBody(resData?.error?.code || resData?.error?.message || bodyText, this.config.displayName);
      return {
        success: false,
        code: classified.code,
        message: classified.technicalDetail,
        friendlyMessage: classified.friendlyMessage,
        hint: classified.hint,
      };
    } catch (e: any) {
      const err = classifyException(e, this.config.displayName);
      return {
        success: false,
        code: err.code,
        message: err.technicalDetail,
        friendlyMessage: err.friendlyMessage,
        hint: err.hint,
      };
    }
  }

  async validateCredentials(apiKey: string, apiSecret: string): Promise<ValidationResult> {
    return this.testConnection(apiKey, apiSecret);
  }

  async fetchMarketData(): Promise<MarketTicker[]> {
    try {
      const [response] = await Promise.all([
        fetch(`${this.getRestUrl()}/v2/tickers`),
        this.getSymbolMetadata("BTC"),
      ]);

      if (!response.ok) return [];

      const tickersData = await response.json() as any;
      if (!tickersData.success || !Array.isArray(tickersData.result)) return [];

      const result: MarketTicker[] = [];
      for (const item of tickersData.result) {
        if (!item.symbol) continue;
        const key = SymbolResolver.toCacheKey(item.symbol);
        const lot = this.metadataCache?.get(key);
        if (!lot) continue;

        const price = parseFloat(item.close || item.last_price || 0);
        const volume24h = parseFloat(item.volume || 0);

        result.push({
          symbol: lot.baseAsset,
          price,
          volume24h,
          quoteVolume24h: volume24h * price,
          priceChange24h: parseFloat(item.price_change || 0),
          priceChangePercent24h: parseFloat(item.price_change_percent || 0),
          highPrice24h: parseFloat(item.high_24h || item.high || 0),
          lowPrice24h: parseFloat(item.low_24h || item.low || 0),
          minNotional: lot.minNotional,
          minOrderQty: lot.minQty,
          maxOrderQty: lot.maxQty,
          tickSize: lot.tickSize,
          lotSize: lot.stepSize,
        });

        if (result.length >= 50) break;
      }
      return result;
    } catch {
      return [];
    }
  }

  async fetchTicker(symbol: string): Promise<MarketTicker | null> {
    try {
      const resolved = SymbolResolver.resolve(symbol);
      const [response, lot] = await Promise.all([
        fetch(`${this.getRestUrl()}/v2/tickers/${encodeURIComponent(resolved.symbol)}`),
        this.getSymbolMetadata(resolved.symbol),
      ]);
      if (!response.ok || !lot) return null;
      const data = await response.json() as any;
      const item = data?.result;
      if (!item || !item.symbol) return null;

      const price = parseFloat(item.last_price || item.close || 0);
      const volume24h = parseFloat(item.volume || 0);

      return {
        symbol: lot.baseAsset,
        price,
        volume24h,
        quoteVolume24h: volume24h * price,
        priceChange24h: parseFloat(item.change || 0),
        priceChangePercent24h: parseFloat(item.change_percent || 0),
        highPrice24h: parseFloat(item.high || 0),
        lowPrice24h: parseFloat(item.low || 0),
        minNotional: lot.minNotional,
        minOrderQty: lot.minQty,
        maxOrderQty: lot.maxQty,
        tickSize: lot.tickSize,
        lotSize: lot.stepSize,
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

  async placeOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    apiKey: string,
    apiSecret: string,
    quantity?: number,
    clientOrderId?: string,
    orderType?: 'MARKET' | 'LIMIT',
    price?: number,
    stopLoss?: number,
    takeProfit?: number
  ): Promise<OrderResult> {
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
      const type = orderType || 'MARKET';

      const orderPayload: any = {
        symbol: `${symbol.toUpperCase()}USD`,
        side: side === "BUY" ? "buy" : "sell",
        type: type === "LIMIT" ? "limit" : "market",
        size: qty,
      };

      if (type === "LIMIT") {
        if (!price || price <= 0) {
          return { success: false, message: "Limit price is required for LIMIT orders." };
        }
        orderPayload.limit_price = price.toString();
      }

      if (takeProfit && takeProfit > 0) {
        orderPayload.take_profit_order = {
          trigger_price: takeProfit.toString(),
          order_type: "market_order",
        };
      }

      if (stopLoss && stopLoss > 0) {
        orderPayload.stop_loss_order = {
          trigger_price: stopLoss.toString(),
          order_type: "market_order",
        };
      }

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
        exchangeOrderId: data.result?.id,
        protectionMode: (takeProfit || stopLoss) ? 'ATTACHED_TPSL' : undefined,
        price: parseFloat(data.result?.avg_price || price?.toString() || 0),
        quantity: parseFloat(data.result?.size || qty.toString()),
        status: type === 'LIMIT' ? 'open' : 'filled',
      };
    } catch (e: any) {
      this.breaker.recordFailure();
      const err = classifyException(e, this.config.displayName);
      return { success: false, message: err.technicalDetail, code: err.code, friendlyMessage: err.friendlyMessage };
    }
  }

  async cancelOrder(orderId: string, symbol: string, apiKey: string, apiSecret: string): Promise<{ success: boolean; message: string }> {
    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const requestPath = `/v2/orders/${orderId}`;
      const prehash = "DELETE" + timestamp + requestPath;
      const signature = await hmacSha256(prehash, apiSecret);

      const response = await this.fetchWithRetry(`${this.getRestUrl()}${requestPath}`, {
        method: "DELETE",
        headers: {
          "api-key": apiKey,
          "signature": signature,
          "timestamp": timestamp,
        },
      });

      const data = await response.json() as any;
      if (!data.success) {
        return { success: false, message: data.error?.message || "Failed to cancel order" };
      }

      return { success: true, message: "Order cancelled successfully" };
    } catch (e: any) {
      return { success: false, message: e.message || "Failed to cancel order" };
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

  async fetchBalances(apiKey: string, apiSecret: string): Promise<BalanceResponse> {
    const breakerState = this.breaker.check();
    if (!breakerState.allowed) {
      return {
        success: false,
        exchange: this.getName(),
        environment: this.environment,
        primaryAsset: "USDT",
        message: "Circuit breaker is OPEN. Fast-failing request.",
        code: "EXCHANGE_UNAVAILABLE",
        friendlyMessage: "Exchange service is temporarily unavailable. Please try again in a moment.",
      };
    }

    try {
      const cleanKey = cleanCredential(apiKey);
      const cleanSecret = cleanCredential(apiSecret);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const requestPath = "/v2/wallet/balances";
      const prehash = "GET" + timestamp + requestPath;
      const signature = await hmacSha256(prehash, cleanSecret);

      const targetUrls = [this.getRestUrl()];
      let response: Response | null = null;
      let bodyText = "";

      for (const baseUrl of targetUrls) {
        try {
          const res = await fetch(`${baseUrl}${requestPath}`, {
            headers: {
              "api-key": cleanKey,
              "signature": signature,
              "timestamp": timestamp,
            },
          });
          response = res;
          if (res.ok) break;
        } catch {
          // Try fallback URL
        }
      }

      if (!response || !response.ok) {
        this.breaker.recordFailure();
        bodyText = response ? await response.text() : "";
        const err = classifyExchangeResponse(response ? response.status : 503, bodyText, this.config.displayName);
        return {
          success: false,
          exchange: this.getName(),
          environment: this.environment,
          primaryAsset: "USDT",
          message: err.technicalDetail,
          code: err.code,
          friendlyMessage: err.friendlyMessage,
          hint: err.hint,
        };
      }

      const data = (await response.json()) as any;
      if (data.success === false) {
        this.breaker.recordFailure();
        const detail = data.error?.message || "Failed to fetch balances";
        const err = classifyByBody(detail, this.config.displayName);
        return {
          success: false,
          exchange: this.getName(),
          environment: this.environment,
          primaryAsset: "USDT",
          message: detail,
          code: err.code,
          friendlyMessage: err.friendlyMessage,
          hint: err.hint,
        };
      }

      const balances: BalanceItem[] = [];
      const rawList = Array.isArray(data.result) ? data.result : [];
      for (const item of rawList) {
        const asset = item.asset_symbol || item.asset || "UNKNOWN";
        const free = parseFloat(item.available_balance || item.available || "0");
        const total = parseFloat(item.balance || "0");
        const locked = parseFloat(item.locked_balance || "0");
        if (total > 0 || asset === "USDT") {
          balances.push({ asset, free, locked, total });
        }
      }

      if (!balances.some((b) => b.asset === "USDT")) {
        balances.unshift({ asset: "USDT", free: 0, locked: 0, total: 0 });
      }

      this.breaker.recordSuccess();
      return {
        success: true,
        exchange: this.getName(),
        environment: this.environment,
        primaryAsset: "USDT",
        balances,
        message: "Success",
      };
    } catch (e: any) {
      this.breaker.recordFailure();
      const err = classifyException(e, this.config.displayName);
      return {
        success: false,
        exchange: this.getName(),
        environment: this.environment,
        primaryAsset: "USDT",
        message: err.technicalDetail,
        code: err.code,
        friendlyMessage: err.friendlyMessage,
        hint: err.hint,
      };
    }
  }
}
