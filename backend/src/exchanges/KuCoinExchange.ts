import { IExchangeAdapter, ValidationResult, MarketTicker, OrderResult, Kline, BalanceResponse, BalanceItem, normalizeQuantity } from "./BaseExchange";
import { ExchangeConfig, ExchangeEnvironment, ExchangeRegion, SymbolMetadata } from "./types";
import { classifyExchangeResponse, classifyException } from "./errors";
import { CircuitBreaker } from "./CircuitBreaker";
import { cleanCredential } from "../crypto";
import { SymbolResolver } from "../utils/SymbolResolver";

async function hmacSha256Base64(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  
  // Convert ArrayBuffer to base64 securely
  let binary = '';
  const bytes = new Uint8Array(signature);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function normalizeKlineInterval(interval: string): string {
  const map: Record<string, string> = {
    "1m": "1min",
    "3m": "3min",
    "5m": "5min",
    "15m": "15min",
    "30m": "30min",
    "1h": "1hour",
    "2h": "2hour",
    "4h": "4hour",
    "6h": "6hour",
    "8h": "8hour",
    "12h": "12hour",
    "1d": "1day",
    "1w": "1week",
  };
  return map[interval] ?? interval;
}

export class KuCoinExchange implements IExchangeAdapter {
  readonly config: ExchangeConfig = {
    name: "kucoin",
    displayName: "KuCoin",
    defaultRegion: "global",
    regionUrls: {
      global: "https://api.kucoin.com",
      india: "https://api.kucoin.com",
    },
    regionTestnetUrls: {
      global: "https://openapi-sandbox.kucoin.com",
      india: "https://openapi-sandbox.kucoin.com",
    },
  };

  private environment: ExchangeEnvironment = "mainnet";
  private region: ExchangeRegion = "global";

  constructor(environment: ExchangeEnvironment = "mainnet", region: ExchangeRegion = "global") {
    this.environment = environment;
    this.region = region;
  }

  // Cache state properties
  private metadataCache: Map<string, SymbolMetadata> | null = null;
  private lastCacheFetch = 0;
  private cacheFetchPromise: Promise<Map<string, SymbolMetadata>> | null = null;
  public breaker = new CircuitBreaker(5, 60000);

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

  private maskString(str: string | undefined): string {
    if (!str || str.length < 8) return "***";
    return str.substring(0, 4) + "***" + str.substring(str.length - 4);
  }

  private async signRequest(
    method: string,
    endpoint: string,
    apiKey: string,
    apiSecret: string,
    apiPassphrase?: string,
    body?: any
  ): Promise<Headers> {
    const timestamp = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const message = timestamp + method + endpoint + bodyStr;

    const signature = await hmacSha256Base64(message, apiSecret);
    let passphraseSignature = '';
    if (apiPassphrase) {
        passphraseSignature = await hmacSha256Base64(apiPassphrase, apiSecret);
    }

    const headers = new Headers({
      'KC-API-KEY': apiKey,
      'KC-API-SIGN': signature,
      'KC-API-TIMESTAMP': timestamp,
      'KC-API-KEY-VERSION': '2',
      'Content-Type': 'application/json'
    });

    if (passphraseSignature) {
        headers.set('KC-API-PASSPHRASE', passphraseSignature);
    }

    return headers;
  }

  public getRestUrl(): string {
    if (this.environment === "testnet") {
      return this.config.regionTestnetUrls?.[this.region] || this.config.regionTestnetUrls?.global || "";
    }
    return this.config.regionUrls[this.region] || this.config.regionUrls.global;
  }

  public setEnvironment(environment: ExchangeEnvironment): void {
    this.environment = environment;
  }

  public setRegion(region: ExchangeRegion): void {
    this.region = region;
  }

  public getName(): string {
    return this.config.name;
  }

  private async fetchExchangeMetadata(): Promise<Map<string, SymbolMetadata>> {
    const response = await this.fetchWithRetry(`${this.getRestUrl()}/api/v2/symbols`);
    const data = await response.json() as any;
    const map = new Map<string, SymbolMetadata>();

    if (data.code !== '200000') {
      throw new Error(`Failed to fetch metadata: ${data.msg}`);
    }

    for (const symObj of data.data ?? []) {
      if (!symObj.enableTrading) continue;
      
      const minQty = parseFloat(symObj.baseMinSize || "0");
      const maxQty = parseFloat(symObj.baseMaxSize || "999999999");
      const stepSize = parseFloat(symObj.baseIncrement || "0");
      const tickSize = parseFloat(symObj.priceIncrement || "0");
      const minNotional = parseFloat(symObj.minFunds || "0");

      if (isNaN(minQty) || isNaN(maxQty) || isNaN(stepSize) || isNaN(tickSize)) continue;

      const resolved = SymbolResolver.resolve(symObj.symbol);
      map.set(resolved.symbol, {
        schemaVersion: "2.0",
        symbol: resolved.symbol,
        exchange: "kucoin",
        baseAsset: resolved.baseAsset,
        quoteAsset: resolved.quoteAsset,
        minNotional,
        minQty,
        maxQty,
        stepSize,
        tickSize,
        minPrice: tickSize,
        maxPrice: 999999999,
        contractSize: 1.0,
        lastUpdated: Date.now(),
      });
    }
    console.log(`[KuCoin] Metadata successfully loaded: ${map.size} symbols.`);
    return map;
  }

  private async getSymbolMetadata(symbol: string): Promise<SymbolMetadata | null> {
    const key = SymbolResolver.toCacheKey(symbol);
    const now = Date.now();
    const expiryLimit = 1800000; // 30 minutes
    const hasCache = this.metadataCache !== null;
    const isExpired = now - this.lastCacheFetch > expiryLimit;

    if (isExpired && hasCache) {
      if (!this.cacheFetchPromise) {
        this.cacheFetchPromise = (async () => {
          try {
            const freshMap = await this.fetchExchangeMetadata();
            this.metadataCache = freshMap;
            this.lastCacheFetch = Date.now();
            return freshMap;
          } catch (err) {
            console.error("[KuCoin] Background cache refresh failed, keeping existing cache:", err);
            this.lastCacheFetch = Date.now() - 1500000; // retry in 5 minutes
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
            this.lastCacheFetch = 0;
            throw err;
          } finally {
            this.cacheFetchPromise = null;
          }
        })();
      }
      const map = await this.cacheFetchPromise;
      return map.get(key) ?? null;
    }

    return this.metadataCache!.get(key) ?? null;
  }

  async validateCredentials(apiKey: string, apiSecret: string, apiPassphrase?: string): Promise<ValidationResult> {
    try {
      const cleanKey = cleanCredential(apiKey);
      const cleanSecret = cleanCredential(apiSecret);
      const cleanPassphrase = cleanCredential(apiPassphrase);
      
      const endpoint = '/api/v1/accounts';
      const headers = await this.signRequest('GET', endpoint, cleanKey, cleanSecret, cleanPassphrase);
      
      const res = await fetch(`${this.getRestUrl()}${endpoint}`, { headers });
      const text = await res.text();
      
      if (!res.ok || (res.ok && text.includes('"code":') && !text.includes('"code":"200000"'))) {
        const error = classifyExchangeResponse(res.status, text, this.getName());
        return {
          success: false,
          message: error.friendlyMessage,
          code: error.code,
          friendlyMessage: error.friendlyMessage,
          hint: error.hint,
        };
      }

      return {
        success: true,
        message: "KuCoin credentials validated successfully",
      };
    } catch (error: unknown) {
      const classified = classifyException(error, this.getName());
      return {
        success: false,
        message: classified.friendlyMessage,
        code: classified.code,
        friendlyMessage: classified.friendlyMessage,
        hint: classified.hint,
      };
    }
  }

  async fetchMarketData(): Promise<MarketTicker[]> {
    const res = await fetch(`${this.getRestUrl()}/api/v1/market/allTickers`);
    const data = await res.json() as any;
    
    if (data.code !== '200000') {
      throw new Error(`KuCoin fetchMarketData failed: ${data.msg}`);
    }
    
    const tickers = data.data?.ticker ?? [];
    const result: MarketTicker[] = [];

    // Pre-fetch metadata if cache is empty to avoid blocking individually
    if (!this.metadataCache) {
       await this.getSymbolMetadata('BTC-USDT'); // Force a cache warm-up
    }

    for (const t of tickers) {
      if (!t.symbol.endsWith("-USDT")) continue;
      const key = SymbolResolver.toCacheKey(t.symbol);
      const lot = this.metadataCache?.get(key);
      if (!lot) continue;

      const price = parseFloat(t.last || "0");
      const volume24h = parseFloat(t.vol || "0");

      result.push({
        symbol: lot.baseAsset,
        price,
        priceChange24h: parseFloat(t.changePrice || "0"), // fallback for KuCoin
        priceChangePercent24h: parseFloat(t.changeRate || "0") * 100, // KuCoin gives rate (e.g. 0.05 for 5%)
        volume24h,
        quoteVolume24h: parseFloat(t.volValue || (volume24h * price).toString() || "0"),
        highPrice24h: parseFloat(t.high || "0"),
        lowPrice24h: parseFloat(t.low || "0"),
        minNotional: lot.minNotional,
        minOrderQty: lot.minQty,
        maxOrderQty: lot.maxQty,
        tickSize: lot.tickSize,
        lotSize: lot.stepSize,
      });
      if (result.length >= 50) break;
    }
    
    return result;
  }

  async fetchTicker(symbol: string): Promise<MarketTicker | null> {
    const resolved = SymbolResolver.resolve(symbol);
    const [res, lot] = await Promise.all([
      fetch(`${this.getRestUrl()}/api/v1/market/stats?symbol=${resolved.symbol}`),
      this.getSymbolMetadata(resolved.symbol),
    ]);
    
    if (!lot) return null;

    const data = await res.json() as any;

    if (data.code !== '200000') return null;
    const t = data.data;
    if (!t) return null;

    const price = parseFloat(t.last || "0");
    const volume24h = parseFloat(t.vol || "0");

    return {
      symbol: lot.baseAsset,
      price,
      priceChange24h: parseFloat(t.changePrice || "0"),
      priceChangePercent24h: parseFloat(t.changeRate || "0") * 100,
      volume24h,
      quoteVolume24h: parseFloat(t.volValue || (volume24h * price).toString() || "0"),
      highPrice24h: parseFloat(t.high || "0"),
      lowPrice24h: parseFloat(t.low || "0"),
      minNotional: lot.minNotional,
      minOrderQty: lot.minQty,
      maxOrderQty: lot.maxQty,
      tickSize: lot.tickSize,
      lotSize: lot.stepSize,
    };
  }

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    const kucoinInterval = normalizeKlineInterval(interval);
    
    // KuCoin uses seconds for timestamp query params
    const endAt = Math.floor(Date.now() / 1000);
    // Rough estimate of startAt based on limit and interval
    let secondsPerInterval = 60;
    if (kucoinInterval.endsWith('min')) secondsPerInterval = parseInt(kucoinInterval) * 60;
    else if (kucoinInterval.endsWith('hour')) secondsPerInterval = parseInt(kucoinInterval) * 3600;
    else if (kucoinInterval.endsWith('day')) secondsPerInterval = parseInt(kucoinInterval) * 86400;
    else if (kucoinInterval.endsWith('week')) secondsPerInterval = parseInt(kucoinInterval) * 604800;
    
    const startAt = endAt - (limit * secondsPerInterval);

    const resolved = SymbolResolver.resolve(symbol);
    const formattedSymbol = `${resolved.baseAsset}-${resolved.quoteAsset}`;
    const endpoint = `/api/v1/market/candles?symbol=${formattedSymbol}&type=${kucoinInterval}&startAt=${startAt}&endAt=${endAt}`;
    const res = await fetch(`${this.getRestUrl()}${endpoint}`);
    const data = await res.json() as any;

    if (data.code !== '200000') {
       throw new Error(`KuCoin fetchKlines failed: ${data.msg}`);
    }

    const klines = data.data ?? [];
    
    // KuCoin returns data in descending order (latest first), but our interface expects ascending (oldest first).
    // Format: [ "time", "open", "close", "high", "low", "volume", "turnover" ]
    return klines.reverse().slice(-limit).map((k: string[]) => ({
      openTime: parseInt(k[0]) * 1000,
      open: parseFloat(k[1]),
      close: parseFloat(k[2]),
      high: parseFloat(k[3]),
      low: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
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
    _stopLoss?: number,
    _takeProfit?: number,
    apiPassphrase?: string
  ): Promise<OrderResult> {
    const breakerState = this.breaker.check();
    if (!breakerState.allowed) {
      return { success: false, message: "Circuit breaker is OPEN. Fast-failing request." };
    }

    try {
      const meta = await this.getSymbolMetadata(symbol);
      let qtyStr = quantity ? quantity.toString() : undefined;
      let priceStr = price ? price.toString() : undefined;

      if (meta) {
        if (quantity) {
          const normQty = normalizeQuantity(quantity, meta.stepSize, meta.minQty, meta.maxQty);
          qtyStr = normQty.toString();
        }
        if (price) {
          const normPrice = normalizeQuantity(price, meta.tickSize, meta.minPrice, meta.maxPrice);
          priceStr = normPrice.toString();
        }
      }

      const clientOid = clientOrderId || crypto.randomUUID();
      const payload: any = {
        clientOid,
        side: side.toLowerCase(),
        symbol,
        type: (orderType || 'MARKET').toLowerCase(),
      };

      if (payload.type === 'limit' && priceStr) {
        payload.price = priceStr;
      }
      
      if (qtyStr) {
        payload.size = qtyStr;
      }

      const endpoint = '/api/v1/orders';
      const headers = await this.signRequest('POST', endpoint, apiKey, apiSecret, apiPassphrase, payload);
      
      const res = await fetch(`${this.getRestUrl()}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      const text = await res.text();

      if (!res.ok || (res.ok && text.includes('"code":') && !text.includes('"code":"200000"'))) {
        const error = classifyExchangeResponse(res.status, text, this.getName());
        this.breaker.recordFailure();
        return { success: false, message: error.friendlyMessage, code: error.code };
      }

      this.breaker.recordSuccess();
      const data = JSON.parse(text) as any;
      return {
        success: true,
        message: "Order placed successfully",
        orderId: clientOid,
        exchangeOrderId: data.data?.orderId,
        status: "open",
        price,
        quantity,
      };
    } catch (err: any) {
      this.breaker.recordFailure();
      return { success: false, message: err.message };
    }
  }

  async placeOcoOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    apiKey: string,
    apiSecret: string,
    quantity: number,
    takeProfitPrice: number,
    stopLossPrice: number,
    clientOrderId?: string,
    apiPassphrase?: string
  ): Promise<OrderResult> {
    const breakerState = this.breaker.check();
    if (!breakerState.allowed) {
      return { success: false, message: "Circuit breaker is OPEN. Fast-failing request." };
    }

    try {
      const meta = await this.getSymbolMetadata(symbol);
      let qtyStr = quantity.toString();
      let tpStr = takeProfitPrice.toString();
      let slStr = stopLossPrice.toString();

      if (meta) {
        qtyStr = normalizeQuantity(quantity, meta.stepSize, meta.minQty, meta.maxQty).toString();
        tpStr = normalizeQuantity(takeProfitPrice, meta.tickSize, meta.minPrice, meta.maxPrice).toString();
        slStr = normalizeQuantity(stopLossPrice, meta.tickSize, meta.minPrice, meta.maxPrice).toString();
      }

      const clientOid = clientOrderId || crypto.randomUUID();
      const payload = {
        clientOid,
        side: side.toLowerCase(),
        symbol,
        price: tpStr, // KuCoin OCO 'price' is the take profit limit price
        stopPrice: slStr, // KuCoin OCO 'stopPrice' is the stop loss trigger price
        limitPrice: slStr, // KuCoin OCO 'limitPrice' is the stop loss execution limit price
        size: qtyStr
      };

      const endpoint = '/api/v3/oco/order';
      const headers = await this.signRequest('POST', endpoint, apiKey, apiSecret, apiPassphrase, payload);

      const res = await fetch(`${this.getRestUrl()}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      const text = await res.text();

      if (!res.ok || (res.ok && text.includes('"code":') && !text.includes('"code":"200000"'))) {
        const error = classifyExchangeResponse(res.status, text, this.getName());
        this.breaker.recordFailure();
        return { success: false, message: error.friendlyMessage, code: error.code };
      }

      this.breaker.recordSuccess();
      const data = JSON.parse(text) as any;
      return {
        success: true,
        message: "OCO Order placed successfully",
        orderId: clientOid,
        exchangeOrderId: data.data?.orderId,
        ocoGroupId: data.data?.orderId,
        status: "open",
        protectionMode: 'NATIVE_OCO'
      };
    } catch (err: any) {
      this.breaker.recordFailure();
      return { success: false, message: err.message };
    }
  }

  async cancelOrder(
    orderId: string,
    symbol: string,
    apiKey: string,
    apiSecret: string,
    apiPassphrase?: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      // KuCoin natively supports cancelling by clientOid using a specific endpoint
      let endpoint = `/api/v1/orders/${orderId}`;
      if (orderId.includes('-') && orderId.length > 20) {
        endpoint = `/api/v1/order/client-order/${orderId}`;
      }

      const headers = await this.signRequest('DELETE', endpoint, apiKey, apiSecret, apiPassphrase);
      const res = await fetch(`${this.getRestUrl()}${endpoint}`, {
        method: 'DELETE',
        headers
      });
      const text = await res.text();

      if (!res.ok || (res.ok && text.includes('"code":') && !text.includes('"code":"200000"'))) {
        const error = classifyExchangeResponse(res.status, text, this.getName());
        return { success: false, message: error.friendlyMessage };
      }

      return { success: true, message: "Order cancelled" };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  async fetchOrder(
    orderId: string,
    apiKey: string,
    apiSecret: string,
    apiPassphrase?: string
  ): Promise<OrderResult> {
    try {
      let endpoint = `/api/v1/orders/${orderId}`;
      if (orderId.includes('-') && orderId.length > 20) {
        endpoint = `/api/v1/order/client-order/${orderId}`;
      }

      const headers = await this.signRequest('GET', endpoint, apiKey, apiSecret, apiPassphrase);
      const res = await fetch(`${this.getRestUrl()}${endpoint}`, { headers });
      const text = await res.text();

      if (!res.ok || (res.ok && text.includes('"code":') && !text.includes('"code":"200000"'))) {
        const error = classifyExchangeResponse(res.status, text, this.getName());
        return { success: false, message: error.friendlyMessage, code: error.code };
      }

      const data = JSON.parse(text) as any;
      const order = data.data;
      if (!order) {
         return { success: false, message: "Order not found", status: "rejected" };
      }

      let internalStatus: OrderResult['status'] = 'open';
      if (!order.isActive) {
        if (order.cancelExist) internalStatus = 'cancelled';
        else if (parseFloat(order.dealSize || "0") > 0) internalStatus = 'filled';
        else internalStatus = 'cancelled'; // If not active, not filled, and no cancel exist, maybe rejected?
      } else if (parseFloat(order.dealSize || "0") > 0) {
        internalStatus = 'partially_filled';
      }

      return {
        success: true,
        message: "Order fetched",
        orderId: order.clientOid,
        exchangeOrderId: order.id,
        status: internalStatus,
        price: parseFloat(order.price || "0"),
        quantity: parseFloat(order.size || "0"),
        filledQuantity: parseFloat(order.dealSize || "0"),
        averageFillPrice: parseFloat(order.dealFunds || "0") / (parseFloat(order.dealSize || "1") || 1),
      };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  async fetchBalances(apiKey: string, apiSecret: string, apiPassphrase?: string): Promise<BalanceResponse> {
    const breakerState = this.breaker.check();
    if (!breakerState.allowed) {
      return {
        success: false,
        exchange: this.getName(),
        environment: this.environment,
        primaryAsset: "USDT",
        message: "Circuit breaker is OPEN. Fast-failing request.",
        code: "EXCHANGE_UNAVAILABLE",
      };
    }

    try {
      const endpoint = '/api/v1/accounts';
      const headers = await this.signRequest('GET', endpoint, apiKey, apiSecret, apiPassphrase);
      
      const res = await fetch(`${this.getRestUrl()}${endpoint}`, { headers });
      const text = await res.text();

      if (!res.ok || (res.ok && text.includes('"code":') && !text.includes('"code":"200000"'))) {
        const error = classifyExchangeResponse(res.status, text, this.getName());
        this.breaker.recordFailure();
        return {
          success: false,
          exchange: this.getName(),
          environment: this.environment,
          code: error.code,
          message: error.friendlyMessage,
          hint: error.hint,
        };
      }

      this.breaker.recordSuccess();
      const data = JSON.parse(text) as any;
      
      const balances: BalanceItem[] = (data.data ?? []).map((b: any) => ({
        asset: b.currency,
        free: parseFloat(b.available || "0"),
        locked: parseFloat(b.holds || "0"),
        total: parseFloat(b.balance || "0"),
      }));

      return {
        success: true,
        exchange: this.getName(),
        environment: this.environment,
        primaryAsset: "USDT",
        message: "Balances fetched successfully.",
        balances,
      };
    } catch (error: unknown) {
      this.breaker.recordFailure();
      const classified = classifyException(error, this.getName());
      return {
        success: false,
        exchange: this.getName(),
        environment: this.environment,
        primaryAsset: "USDT",
        message: classified.friendlyMessage,
        code: classified.code,
      };
    }
  }
}
