import { IExchangeAdapter, ValidationResult, MarketTicker, OrderResult, Kline } from "./BaseExchange";
import { ExchangeConfig, ExchangeEnvironment, ExchangeRegion } from "./types";
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

      return { success: true, message: "Binance credentials validated successfully" };
    } catch (e: any) {
      const err = classifyException(e, this.config.displayName);
      return { success: false, message: err.technicalDetail, code: err.code, friendlyMessage: err.friendlyMessage };
    }
  }

  async fetchMarketData(): Promise<MarketTicker[]> {
    try {
      const [tickersResponse, exchangeInfoResponse] = await Promise.all([
        fetch(`${this.getRestUrl()}/api/v3/ticker/24hr`),
        fetch(`${this.getRestUrl()}/api/v3/exchangeInfo`),
      ]);

      if (!tickersResponse.ok || !exchangeInfoResponse.ok) {
        return [];
      }

      const tickers = await tickersResponse.json() as any[];
      const exchangeInfo = await exchangeInfoResponse.json() as any;

      const lotSizeMap = new Map<string, { minQty: number; maxQty: number; tickSize: number; lotSize: number }>();
      for (const symbol of exchangeInfo.symbols ?? []) {
        const filters = symbol.filters ?? [];
        const lotFilter = filters.find((f: any) => f.filterType === "LOT_SIZE");
        const priceFilter = filters.find((f: any) => f.filterType === "PRICE_FILTER");
        if (lotFilter && symbol.status === "TRADING") {
          lotSizeMap.set(symbol.symbol, {
            minQty: parseFloat(lotFilter.minQty || "0"),
            maxQty: parseFloat(lotFilter.maxQty || "999999999"),
            tickSize: parseFloat(priceFilter?.tickSize || "0.01"),
            lotSize: parseFloat(lotFilter.stepSize || "1"),
          });
        }
      }

      return tickers
        .filter((item: any) => item.symbol.endsWith("USDT") || item.symbol.endsWith("BUSD"))
        .slice(0, 50)
        .map((item: any) => {
          const lot = lotSizeMap.get(item.symbol) ?? { minQty: 0.001, maxQty: 999999999, tickSize: 0.01, lotSize: 1 };
          return {
            symbol: item.symbol.replace(/USDT|BUSD$/, ""),
            price: parseFloat(item.lastPrice),
            volume24h: parseFloat(item.volume),
            quoteVolume24h: parseFloat(item.quoteVolume || item.volume * item.lastPrice || 0),
            priceChange24h: parseFloat(item.priceChange),
            priceChangePercent24h: parseFloat(item.priceChangePercent),
            highPrice24h: parseFloat(item.highPrice),
            lowPrice24h: parseFloat(item.lowPrice),
            minNotional: lot.minQty * (parseFloat(item.lastPrice) || 1),
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
      const response = await fetch(
        `${this.getRestUrl()}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol.toUpperCase())}USDT`,
      );
      if (!response.ok) return null;
      const item = (await response.json()) as any;
      if (!item || !item.symbol) return null;
      const defaults = { minQty: 0.001, maxQty: 999999999, tickSize: 0.01, lotSize: 1 };
      return {
        symbol: item.symbol.replace(/USDT|BUSD$/, ""),
        price: parseFloat(item.lastPrice || 0),
        volume24h: parseFloat(item.volume || 0),
        quoteVolume24h: parseFloat(item.quoteVolume || (item.volume * item.lastPrice) || 0),
        priceChange24h: parseFloat(item.priceChange || 0),
        priceChangePercent24h: parseFloat(item.priceChangePercent || 0),
        highPrice24h: parseFloat(item.highPrice || 0),
        lowPrice24h: parseFloat(item.lowPrice || 0),
        minNotional: defaults.minQty * (parseFloat(item.lastPrice || 0) || 1),
        minOrderQty: defaults.minQty,
        maxOrderQty: defaults.maxQty,
        tickSize: defaults.tickSize,
        lotSize: defaults.lotSize,
      };
    } catch {
      return null;
    }
  }

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    try {
      const params = new URLSearchParams({
        symbol: `${symbol.toUpperCase()}USDT`,
        interval,
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
