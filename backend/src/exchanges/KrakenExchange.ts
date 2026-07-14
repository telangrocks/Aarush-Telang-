import { IExchangeAdapter, ValidationResult, MarketTicker, Kline, OrderResult } from "./BaseExchange";
import { ExchangeConfig, ExchangeEnvironment } from "./types";

async function hmacSha512(message: string, secret: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, encoder.encode(message));
}

function base64Encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class KrakenExchange implements IExchangeAdapter {
  readonly config: ExchangeConfig = {
    name: "kraken",
    displayName: "Kraken",
    restUrl: "https://api.kraken.com",
    testnetUrl: "https://sandbox.kraken.com",
  };

  private environment: ExchangeEnvironment = "mainnet";

  getName() {
    return this.config.displayName;
  }

  setEnvironment(environment: ExchangeEnvironment) {
    this.environment = environment;
  }

  getRestUrl(): string {
    return this.environment === "testnet" && this.config.testnetUrl
      ? this.config.testnetUrl
      : this.getRestUrl();
  }

  async validateCredentials(apiKey: string, apiSecret: string): Promise<ValidationResult> {
    try {
      const nonce = Date.now().toString();
      const body = `nonce=${nonce}&otp=`;
      const path = "/0/private/Balance";

      const signature = base64Encode(await hmacSha512(path + btoa(nonce) + btoa(body), apiSecret));

      const response = await fetch(`${this.getRestUrl()}${path}`, {
        method: "POST",
        headers: {
          "API-Key": apiKey,
          "API-Sign": signature,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      if (!response.ok) {
        const bodyText = await response.text();
        return { success: false, message: `HTTP ${response.status}: ${bodyText}` };
      }

      const data = await response.json() as any;
      if (data.error && data.error.length > 0) {
        return { success: false, message: data.error.join(", ") };
      }

      return { success: true, message: "Kraken credentials validated successfully" };
    } catch (e: any) {
      return { success: false, message: e.message || "Network error during validation" };
    }
  }

  async fetchMarketData(): Promise<MarketTicker[]> {
    try {
      const pairs = "XBTUSD,ETHUSD,SOLUSD,BNBUSD,XRPUSD,DOGEUSD,ADAUSD,AVAXUSD,DOTUSD,LINKUSD,MATICUSD,NEARUSD";
      const [tickersResponse, assetPairsResponse] = await Promise.all([
        fetch(`${this.getRestUrl()}/0/public/Ticker?pair=${pairs}`),
        fetch(`${this.getRestUrl()}/0/public/AssetPairs?pair=${pairs}`),
      ]);

      if (!tickersResponse.ok || !assetPairsResponse.ok) {
        return [];
      }

      const tickersData = await tickersResponse.json() as any;
      const assetPairsData = await assetPairsResponse.json() as any;

      if (tickersData.error && tickersData.error.length > 0) {
        return [];
      }

      const minNotionalMap = new Map<string, number>();
      for (const [key, item] of Object.entries(assetPairsData.result ?? {})) {
        const pair = item as any;
        const ordermin = parseFloat(pair.ordermin ?? "0");
        const symbol = pair.wsname?.split("/")[0] || key.replace("USD", "");
        if (symbol && ordermin > 0) {
          minNotionalMap.set(symbol, ordermin);
        }
      }

      const result = tickersData.result || {};
      return Object.values(result).map((item: any) => {
        const symbol = item.wsname?.split("/")[0] || Object.keys(result)[0];
        const open24h = parseFloat(item.o?.[1] || item.o?.[0] || 0);
        const last = parseFloat(item.c?.[0] || item.p?.[1] || 0);
        const changePercent = open24h > 0 ? ((last - open24h) / open24h) * 100 : 0;
        return {
          symbol,
          price: last,
          volume24h: parseFloat(item.v?.[1] || 0),
          priceChange24h: last - open24h,
          priceChangePercent24h: changePercent,
          highPrice24h: parseFloat(item.h?.[1] || 0),
          lowPrice24h: parseFloat(item.l?.[1] || 0),
          minNotional: minNotionalMap.get(symbol) || 0,
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
      const pair = `${symbol.toUpperCase()}USD`;
      const response = await fetch(
        `${this.getRestUrl()}/0/public/Ticker?pair=${encodeURIComponent(pair)}`,
      );
      if (!response.ok) return null;
      const data = await response.json() as any;
      const item = data?.result?.[pair];
      if (!item) return null;
      const last = parseFloat(item.c?.[0] || 0);
      return {
        symbol,
        price: last,
        volume24h: parseFloat(item.v?.[1] || 0),
        priceChange24h: parseFloat(item.p?.[1] || 0),
        priceChangePercent24h: 0,
        highPrice24h: parseFloat(item.h?.[1] || 0),
        lowPrice24h: parseFloat(item.l?.[1] || 0),
        minNotional: 0,
      };
    } catch {
      return null;
    }
  }

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    try {
      const pair = symbol.toUpperCase();
      const response = await fetch(`${this.getRestUrl()}/0/public/OHLC?pair=${pair}USDT&interval=${interval}&count=${limit}`);
      if (!response.ok) return [];
      const data = await response.json() as any;
      if (data.error && data.error.length > 0) return [];
      const result = data.result?.[pair] || data.result?.[Object.keys(data.result || {})[0]] || [];
      if (!Array.isArray(result)) return [];
      return result.map((k: any[]) => ({
        openTime: parseInt(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[6]),
        closeTime: parseInt(k[0]) + 3600000,
      }));
    } catch {
      return [];
    }
  }

  async placeOrder(symbol: string, side: 'BUY' | 'SELL', apiKey: string, apiSecret: string, _quantity?: number): Promise<OrderResult> {
    try {
      const nonce = Date.now().toString();
      const pair = `${symbol.toUpperCase()}USDT`;
      const volume = "0.001";
      const body = `nonce=${nonce}&pair=${pair}&type=${side === "BUY" ? "buy" : "sell"}&ordertype=market&volume=${volume}`;
      const path = "/0/private/AddOrder";
      const signature = base64Encode(await hmacSha512(path + btoa(nonce) + btoa(body), apiSecret));

      const response = await fetch(`${this.getRestUrl()}${path}`, {
        method: "POST",
        headers: {
          "API-Key": apiKey,
          "API-Sign": signature,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      const data = await response.json() as any;
      if (data.error && data.error.length > 0) {
        return { success: false, message: data.error.join(", ") };
      }

      const txid = data.result?.txid?.[0];
      return {
        success: true,
        message: "Order placed successfully",
        orderId: txid,
        price: 0,
        quantity: parseFloat(volume),
      };
    } catch (e: any) {
      return { success: false, message: e.message || "Network error during order placement" };
    }
  }
}
