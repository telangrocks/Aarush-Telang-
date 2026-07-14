import { IExchangeAdapter, ValidationResult, MarketTicker, Kline, OrderResult } from "./BaseExchange";
import { ExchangeConfig, ExchangeEnvironment } from "./types";

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

export class DeltaExchange implements IExchangeAdapter {
  readonly config: ExchangeConfig = {
    name: "delta",
    displayName: "Delta Exchange",
    restUrl: "https://api.delta.exchange",
    testnetUrl: "https://api-testnet.delta.exchange",
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
      : this.config.restUrl;
  }

  async validateCredentials(apiKey: string, apiSecret: string): Promise<ValidationResult> {
    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const requestPath = "/v2/account/wallet/balance";
      const query = `timestamp=${timestamp}`;
      const prehash = timestamp + "GET" + requestPath + "?" + query;
      const signature = await hmacSha256(prehash, apiSecret);

      const response = await fetch(`${this.getRestUrl()}${requestPath}?${query}`, {
        headers: {
          "API-Key": apiKey,
          "Signature": signature,
        },
      });

      if (!response.ok) {
        const body = await response.text();
        return { success: false, message: `HTTP ${response.status}: ${body}` };
      }

      const data = await response.json() as any;
      if (data.success === false) {
        return { success: false, message: data.error?.message || "Invalid API credentials" };
      }

      return { success: true, message: "Delta Exchange credentials validated successfully" };
    } catch (e: any) {
      return { success: false, message: e.message || "Network error during validation" };
    }
  }

  async fetchMarketData(): Promise<MarketTicker[]> {
    try {
      const [tickersResponse, productsResponse] = await Promise.all([
        fetch(`${this.getRestUrl()}/v2/tickers`),
        fetch(`${this.getRestUrl()}/v2/products`),
      ]);

      if (!tickersResponse.ok || !productsResponse.ok) {
        return [];
      }

      const tickersData = await tickersResponse.json() as any;
      const productsData = await productsResponse.json() as any;

      if (!tickersData.success || !Array.isArray(tickersData.result)) {
        return [];
      }

      const minNotionalMap = new Map<string, number>();
      for (const product of productsData.result ?? []) {
        const symbol = product.symbol;
        const minNotional = parseFloat(product.min_notional ?? product.min_notional_value ?? "0");
        if (symbol) {
          minNotionalMap.set(symbol, minNotional);
        }
      }

      return tickersData.result
        .filter((item: any) => item.symbol && (item.symbol.includes("USDT") || item.symbol.includes("USDC")))
        .slice(0, 50)
        .map((item: any) => ({
          symbol: item.symbol.replace(/USDT$|USDC$/, ""),
          price: parseFloat(item.close || item.last_price || 0),
          volume24h: parseFloat(item.volume || 0),
          priceChange24h: parseFloat(item.price_change || 0),
          priceChangePercent24h: parseFloat(item.price_change_percent || 0),
          highPrice24h: parseFloat(item.high_24h || item.high || 0),
          lowPrice24h: parseFloat(item.low_24h || item.low || 0),
          minNotional: minNotionalMap.get(item.symbol) || 0,
        }));
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
        `${this.getRestUrl()}/v2/ticker/${encodeURIComponent(symbol.toUpperCase())}USDT`,
      );
      if (!response.ok) return null;
      const data = await response.json() as any;
      const item = data?.result;
      if (!item || !item.symbol) return null;
      return {
        symbol: item.symbol.replace("USDT", ""),
        price: parseFloat(item.last_price || item.close || 0),
        volume24h: parseFloat(item.volume || 0),
        priceChange24h: parseFloat(item.change || 0),
        priceChangePercent24h: parseFloat(item.change_percent || 0),
        highPrice24h: parseFloat(item.high || 0),
        lowPrice24h: parseFloat(item.low || 0),
        minNotional: 0,
      };
    } catch {
      return null;
    }
  }

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    try {
      const response = await fetch(`${this.getRestUrl()}/v2/tickers/${symbol.toUpperCase()}USDT/candles?interval=${interval}&limit=${limit}`);
      if (!response.ok) return [];
      const data = await response.json() as any;
      if (!data.success || !Array.isArray(data.result)) return [];
      return data.result.map((k: any[]) => ({
        openTime: parseInt(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: parseInt(k[0]) + 3600000,
      }));
    } catch {
      return [];
    }
  }

  async placeOrder(symbol: string, side: 'BUY' | 'SELL', apiKey: string, apiSecret: string, _quantity?: number): Promise<OrderResult> {
    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const requestPath = "/v2/orders";
      const body = JSON.stringify({
        symbol: `${symbol.toUpperCase()}USDT`,
        side: side === "BUY" ? "buy" : "sell",
        type: "market",
        quantity: 0.001,
      });
      const prehash = timestamp + "POST" + requestPath + body;
      const signature = await hmacSha256(prehash, apiSecret);
      const response = await fetch(`${this.getRestUrl()}${requestPath}`, {
        method: "POST",
        headers: {
          "API-Key": apiKey,
          "Signature": signature,
          "Content-Type": "application/json",
        },
        body,
      });
      const data = await response.json() as any;
      if (!data.success) {
        return { success: false, message: data.error?.message || "Order failed" };
      }
      return {
        success: true,
        message: "Order placed successfully",
        orderId: data.result?.id,
        price: parseFloat(data.result?.avg_price || 0),
        quantity: parseFloat(data.result?.quantity || 0),
      };
    } catch (e: any) {
      return { success: false, message: e.message || "Network error during order placement" };
    }
  }
}
