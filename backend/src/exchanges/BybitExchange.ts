import { IExchangeAdapter, ValidationResult, MarketTicker, Kline, OrderResult, BalanceResponse, BalanceItem } from "./BaseExchange";
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

/**
 * Bybit's v5 kline endpoint expects interval in its own format (numeric
 * minutes, or D/W/M), whereas the rest of the codebase and the mobile app use
 * the conventional "1h"/"1d" style. Normalize either form so klines work
 * consistently across all supported exchanges.
 */
function normalizeKlineInterval(interval: string): string {
  const map: Record<string, string> = {
    "1m": "1",
    "3m": "3",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "1h": "60",
    "2h": "120",
    "4h": "240",
    "6h": "360",
    "12h": "720",
    "1d": "D",
    "1w": "W",
    "1M": "M",
  };
  if (/^\d+$/.test(interval)) return interval;
  return map[interval] ?? "60";
}

export class BybitExchange implements IExchangeAdapter {
  readonly config: ExchangeConfig = {
    name: "bybit",
    displayName: "Bybit",
    defaultRegion: "global",
    regionUrls: {
      global: "https://api.bybit.com",
      india: "https://api.bybit.com",
    },
    regionTestnetUrls: {
      global: "https://api-testnet.bybit.com",
      india: "https://api-testnet.bybit.com",
    },
  };

  private environment: ExchangeEnvironment = "mainnet";
  private region: ExchangeRegion = "global";

  private metadataCache: Map<string, SymbolMetadata> | null = null;
  private lastCacheFetch = 0;
  private cacheFetchPromise: Promise<Map<string, SymbolMetadata>> | null = null;
  public breaker = new CircuitBreaker(5, 60000);

  public cacheMetrics = {
    hits: 0,
    misses: 0,
    refreshes: 0,
    failures: 0,
    staleUsage: 0,
    circuitBreakerStatus: () => this.breaker.check().allowed ? "CLOSED" : "OPEN",
  };

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
    const response = await this.fetchWithRetry(`${this.getRestUrl()}/v5/market/instruments-info?category=spot`);
    const data = await response.json() as any;
    if (data.retCode !== 0 || !data.result || !Array.isArray(data.result.list)) {
      throw new Error(`Bybit API Error ${data.retCode}: ${data.retMsg}`);
    }
    const map = new Map<string, SymbolMetadata>();

    for (const instrument of data.result.list) {
      if (instrument.status && instrument.status.toUpperCase() !== "TRADING") continue;
      const lotSize = instrument.lotSizeFilter ?? {};
      const priceFilter = instrument.priceFilter ?? {};

      const minQty = parseFloat(lotSize.minOrderQty || "0.000001");
      const maxQty = parseFloat(lotSize.maxOrderQty || "999999999");
      const stepSize = parseFloat(lotSize.qtyStep || lotSize.basePrecision || lotSize.minOrderQty || "0.000001");
      const minPrice = parseFloat(priceFilter.minPrice || "0");
      const maxPrice = parseFloat(priceFilter.maxPrice || "999999999");
      const tickSize = parseFloat(priceFilter.tickSize);

      const rawMinAmt = lotSize.minOrderAmt ?? instrument.minNotionalValue;
      const parsedMinAmt = rawMinAmt ? parseFloat(rawMinAmt) : undefined;
      const minNotional = (parsedMinAmt && !isNaN(parsedMinAmt) && parsedMinAmt > 0)
        ? parsedMinAmt
        : minQty * (minPrice > 0 ? minPrice : 1.0);

      if (isNaN(minQty) || isNaN(maxQty) || isNaN(stepSize) || isNaN(tickSize)) continue;

      const resolved = SymbolResolver.resolve(instrument.symbol);
      map.set(resolved.symbol, {
        schemaVersion: "2.0",
        symbol: resolved.symbol,
        exchange: "bybit",
        baseAsset: resolved.baseAsset,
        quoteAsset: resolved.quoteAsset,
        minNotional,
        minQty,
        maxQty,
        stepSize,
        tickSize,
        minPrice,
        maxPrice,
        contractSize: 1.0,
        lastUpdated: Date.now(),
      });
    }
    console.log(`[Bybit] Metadata successfully loaded: ${map.size} symbols.`);
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
            console.error("[Bybit] Background cache refresh failed, keeping existing cache:", err);
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
        console.error("[Bybit] Cold-start metadata download failed:", err);
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
          friendlyMessage: "Please enter both your Bybit API key and API secret.",
          hint: "Ensure you have copied the full API key and secret from your Bybit API management dashboard.",
        };
      }

      const timestamp = Date.now().toString();
      const recvWindow = "5000";
      const queryString = `recvWindow=${recvWindow}&timestamp=${timestamp}`;
      const signature = await hmacSha256(queryString, cleanSec);

      const url = `${this.getRestUrl()}/v5/account/wallet-balance?accountType=UNIFIED`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "X-BAPI-API-KEY": cleanKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
      });

      const bodyText = await response.text();
      let resData: any = null;
      try {
        resData = JSON.parse(bodyText);
      } catch {
        resData = null;
      }

      if (response.ok && resData && resData.retCode === 0) {
        return { success: true, message: "Successfully authenticated with Bybit" };
      }

      const retCode = resData?.retCode;
      const retMsg = resData?.retMsg || bodyText;
      const classified: ClassifiedError = classifyByBody(String(retMsg || retCode || ""), this.config.displayName);

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
        fetch(`${this.getRestUrl()}/v5/market/tickers?category=spot`),
        this.getSymbolMetadata("BTC"),
      ]);

      if (!response.ok) return [];

      const data = await response.json() as any;
      if (data.retCode !== 0 || !Array.isArray(data.result?.list)) return [];

      const result: MarketTicker[] = [];
      for (const item of data.result.list) {
        if (!item.symbol.endsWith("USDT")) continue;
        const key = SymbolResolver.toCacheKey(item.symbol);
        const lot = this.metadataCache?.get(key);
        if (!lot) continue; // Skip items without verified metadata

        const lastPrice = parseFloat(item.lastPrice || 0);
        const prevPrice = parseFloat(item.prevPrice24h || lastPrice);
        const priceChange = lastPrice - prevPrice;
        const priceChangePercent = item.price24hPcnt != null ? parseFloat(item.price24hPcnt) * 100 : (prevPrice > 0 ? (priceChange / prevPrice) * 100 : 0);
        const turnover = parseFloat(item.turnover24h || 0);
        const vol = parseFloat(item.volume24h || 0);
        const quoteVol = turnover > 0 ? turnover : vol * lastPrice;

        result.push({
          symbol: lot.baseAsset,
          price: lastPrice,
          volume24h: vol,
          quoteVolume24h: quoteVol,
          priceChange24h: priceChange,
          priceChangePercent24h: priceChangePercent,
          highPrice24h: parseFloat(item.highPrice24h || 0),
          lowPrice24h: parseFloat(item.lowPrice24h || 0),
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
        fetch(`${this.getRestUrl()}/v5/market/tickers?category=spot&symbol=${encodeURIComponent(resolved.symbol)}`),
        this.getSymbolMetadata(resolved.symbol),
      ]);
      if (!response.ok || !lot) return null;
      const data = await response.json() as any;
      if (data.retCode !== 0 || !Array.isArray(data.result?.list) || data.result.list.length === 0) {
        return null;
      }
      const item = data.result.list[0];
      const lastPrice = parseFloat(item.lastPrice || 0);
      const vol = parseFloat(item.volume24h || 0);

      return {
        symbol: lot.baseAsset,
        price: lastPrice,
        volume24h: vol,
        quoteVolume24h: vol * lastPrice,
        priceChange24h: parseFloat(item.priceChange || 0),
        priceChangePercent24h: parseFloat(item.priceChangePercent || 0),
        highPrice24h: parseFloat(item.highPrice24h || 0),
        lowPrice24h: parseFloat(item.lowPrice24h || 0),
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
      const params = new URLSearchParams({
        category: "spot",
        symbol: `${symbol.toUpperCase()}USDT`,
        interval: normalizeKlineInterval(interval),
        limit: limit.toString(),
      });
      const response = await fetch(`${this.getRestUrl()}/v5/market/kline?${params}`);
      if (!response.ok) return [];
      const data = await response.json() as any;
      if (data.retCode !== 0 || !Array.isArray(data.result?.list)) return [];
      return data.result.list.map((k: any[]) => ({
        openTime: parseInt(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: parseInt(k[6]),
      }));
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
    try {
      const timestamp = Date.now().toString();
      const recvWindow = "5000";
      const orderId = clientOrderId || crypto.randomUUID();
      const qty = quantity ?? 0.001;
      const type = orderType || 'MARKET';

      const payload: any = {
        category: "spot",
        symbol: `${symbol.toUpperCase()}USDT`,
        side: side === "BUY" ? "Buy" : "Sell",
        orderType: type === "LIMIT" ? "Limit" : "MARKET",
        qty: qty.toString(),
        orderLinkId: orderId,
      };

      if (type === "LIMIT") {
        if (!price || price <= 0) {
          return { success: false, message: "Limit price is required for LIMIT orders." };
        }
        payload.price = price.toString();
        payload.timeInForce = "GTC";
      }

      if (takeProfit && takeProfit > 0) {
        payload.takeProfit = takeProfit.toString();
        payload.tpTriggerBy = "LastPrice";
      }

      if (stopLoss && stopLoss > 0) {
        payload.stopLoss = stopLoss.toString();
        payload.slTriggerBy = "LastPrice";
      }

      const body = JSON.stringify(payload);

      const signature = await hmacSha256(
        timestamp + apiKey + recvWindow + body,
        apiSecret
      );

      const response = await fetch(`${this.getRestUrl()}/v5/order/create`, {
        method: "POST",
        headers: {
          "X-BAPI-API-KEY": apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
          "Content-Type": "application/json",
        },
        body,
      });

      const data = await response.json() as any;
      if (data.retCode !== 0) {
        const detail = data.retMsg || "Order failed";
        const err: ClassifiedError = classifyByBody(detail, this.config.displayName);
        return { success: false, message: `${err.code}: ${detail}`, code: err.code, friendlyMessage: err.friendlyMessage };
      }

      return {
        success: true,
        message: "Order placed successfully",
        orderId: data.result?.orderId,
        exchangeOrderId: data.result?.orderId,
        protectionMode: (takeProfit || stopLoss) ? 'ATTACHED_TPSL' : undefined,
        price: parseFloat(data.result?.avgPrice || price?.toString() || 0),
        quantity: parseFloat(data.result?.qty || qty.toString()),
        status: type === 'LIMIT' ? 'open' : 'filled',
      };
    } catch (e: any) {
      const err = classifyException(e, this.config.displayName);
      return { success: false, message: err.technicalDetail, code: err.code, friendlyMessage: err.friendlyMessage };
    }
  }

  async fetchOrder(orderId: string, apiKey: string, apiSecret: string): Promise<OrderResult> {
    try {
      const timestamp = Date.now().toString();
      const recvWindow = "5000";
      const query = `category=spot&orderId=${encodeURIComponent(orderId)}&timestamp=${encodeURIComponent(timestamp)}&recv_window=${recvWindow}`;
      const signature = await hmacSha256(timestamp + apiKey + recvWindow + query, apiSecret);

      const response = await fetch(`${this.getRestUrl()}/v5/order/realtime?${query}`, {
        headers: {
          "X-BAPI-API-KEY": apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
      });

      if (!response.ok) {
        return { success: false, message: "Failed to fetch order" };
      }

      const data = await response.json() as any;
      if (data.retCode !== 0 || !Array.isArray(data.result?.list) || data.result.list.length === 0) {
        return { success: false, message: data.retMsg || "Order not found" };
      }

      const o = data.result.list[0];
      const statusMap: Record<string, any> = {
        'New': 'open',
        'PartiallyFilled': 'partially_filled',
        'Filled': 'filled',
        'Cancelled': 'cancelled',
        'Rejected': 'rejected',
      };

      return {
        success: true,
        message: "Order fetched successfully",
        orderId: o.orderId,
        exchangeOrderId: o.orderId,
        status: statusMap[o.orderStatus] || o.orderStatus?.toLowerCase(),
        averageFillPrice: parseFloat(o.avgPrice || 0),
        filledQuantity: parseFloat(o.cumExecQty || 0),
      };
    } catch (e: any) {
      return { success: false, message: e.message || "Failed to fetch order" };
    }
  }

  async fetchPositions(apiKey: string, apiSecret: string): Promise<{ success: boolean; result: any[]; message: string }> {
    try {
      const timestamp = Date.now().toString();
      const recvWindow = "5000";
      const query = `accountType=UNIFIED&category=spot&timestamp=${encodeURIComponent(timestamp)}&recv_window=${recvWindow}`;
      const signature = await hmacSha256(timestamp + apiKey + recvWindow + query, apiSecret);

      const response = await fetch(`${this.getRestUrl()}/v5/account/wallet-balance?${query}`, {
        headers: {
          "X-BAPI-API-KEY": apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
      });

      if (!response.ok) {
        return { success: false, result: [], message: "Failed to fetch balances" };
      }

      const data = await response.json() as any;
      if (data.retCode !== 0 || !Array.isArray(data.result?.list) || data.result.list.length === 0) {
        return { success: false, result: [], message: data.retMsg || "No balances found" };
      }

      const coins = data.result.list[0].coin || [];
      const positions: any[] = [];
      for (const c of coins) {
        const total = parseFloat(c.walletBalance || "0");
        if (total > 0 && c.coin !== "USDT") {
          positions.push({
            symbol: `${c.coin}USDT`,
            size: total,
            entry_price: 0,
            side: "BUY"
          });
        }
      }

      return { success: true, result: positions, message: "Balances fetched" };
    } catch (e: any) {
      return { success: false, result: [], message: e.message || "Failed to fetch balances" };
    }
  }

  async cancelOrder(orderId: string, symbol: string, apiKey: string, apiSecret: string): Promise<{ success: boolean; message: string }> {
    try {
      const timestamp = Date.now().toString();
      const recvWindow = "5000";
      const body = JSON.stringify({
        category: "spot",
        symbol: `${symbol.toUpperCase()}USDT`,
        orderId: orderId,
      });

      const signature = await hmacSha256(timestamp + apiKey + recvWindow + body, apiSecret);
      const response = await fetch(`${this.getRestUrl()}/v5/order/cancel`, {
        method: "POST",
        headers: {
          "X-BAPI-API-KEY": apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
          "Content-Type": "application/json",
        },
        body,
      });

      const data = await response.json() as any;
      if (data.retCode !== 0) {
        return { success: false, message: data.retMsg || "Failed to cancel order" };
      }

      return { success: true, message: "Order cancelled successfully" };
    } catch (e: any) {
      return { success: false, message: e.message || "Failed to cancel order" };
    }
  }

  async fetchBalances(apiKey: string, apiSecret: string): Promise<BalanceResponse> {
    try {
      const cleanKey = cleanCredential(apiKey);
      const cleanSecret = cleanCredential(apiSecret);
      const timestamp = Date.now().toString();
      const recvWindow = "10000";

      // 1. Try UNIFIED account balance
      const queryUnified = `accountType=UNIFIED`;
      const sigUnified = await hmacSha256(timestamp + cleanKey + recvWindow + queryUnified, cleanSecret);

      let response = await fetch(`${this.getRestUrl()}/v5/account/wallet-balance?${queryUnified}`, {
        headers: {
          "X-BAPI-API-KEY": cleanKey,
          "X-BAPI-SIGN": sigUnified,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
      });

      let data = (await response.json()) as any;

      // 2. Fallback to SPOT account if UNIFIED fails
      if (!response.ok || data.retCode !== 0) {
        const querySpot = `accountType=SPOT`;
        const sigSpot = await hmacSha256(timestamp + cleanKey + recvWindow + querySpot, cleanSecret);
        const spotResponse = await fetch(`${this.getRestUrl()}/v5/account/wallet-balance?${querySpot}`, {
          headers: {
            "X-BAPI-API-KEY": cleanKey,
            "X-BAPI-SIGN": sigSpot,
            "X-BAPI-TIMESTAMP": timestamp,
            "X-BAPI-RECV-WINDOW": recvWindow,
          },
        });
        if (spotResponse.ok) {
          const spotData = await spotResponse.json() as any;
          if (spotData.retCode === 0) {
            response = spotResponse;
            data = spotData;
          }
        }
      }

      if (!response.ok) {
        const body = await response.text();
        const err = classifyExchangeResponse(response.status, body, this.config.displayName);
        return {
          success: false,
          exchange: this.getName(),
          environment: this.environment,
          primaryAsset: "USDT",
          message: "Failed to fetch wallet balances from Bybit",
          code: err.code,
          friendlyMessage: err.friendlyMessage,
          hint: err.hint,
        };
      }

      if (data.retCode !== 0 || !Array.isArray(data.result?.list) || data.result.list.length === 0) {
        const err = classifyByBody(data.retMsg || "No balances found", this.config.displayName);
        return {
          success: false,
          exchange: this.getName(),
          environment: this.environment,
          primaryAsset: "USDT",
          message: data.retMsg || "No balances found",
          code: err.code,
          friendlyMessage: err.friendlyMessage,
          hint: err.hint,
        };
      }

      const coins = data.result.list[0].coin || [];
      const balances: BalanceItem[] = [];
      for (const c of coins) {
        const free = parseFloat(c.availableToWithdraw || c.walletBalance || "0");
        const total = parseFloat(c.walletBalance || "0");
        const locked = Math.max(0, total - free);
        if (total > 0 || c.coin === "USDT") {
          balances.push({ asset: c.coin, free, locked, total });
        }
      }

      if (!balances.some((b) => b.asset === "USDT")) {
        balances.unshift({ asset: "USDT", free: 0, locked: 0, total: 0 });
      }

      return {
        success: true,
        exchange: this.getName(),
        environment: this.environment,
        primaryAsset: "USDT",
        balances,
        message: "Success",
      };
    } catch (e: any) {
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
