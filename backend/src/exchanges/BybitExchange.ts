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
    restUrl: "https://api.bybit.com",
    testnetUrl: "https://api-testnet.bybit.com",
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
      const timestamp = Date.now().toString();
      const recvWindow = "5000";
      const query = `timestamp=${encodeURIComponent(timestamp)}&recv_window=${recvWindow}`;
      const signature = await hmacSha256(timestamp + apiKey + recvWindow + query, apiSecret);

      const response = await fetch(`${this.getRestUrl()}/v5/account/info?${query}`, {
        headers: {
          "X-BAPI-API-KEY": apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
        },
      });

      if (!response.ok) {
        const bodyText = await response.text();
        return { success: false, message: `HTTP ${response.status}: ${bodyText}` };
      }

      const data = await response.json() as any;
      if (data.retCode !== 0) {
        return { success: false, message: data.retMsg || "Invalid API credentials" };
      }

      return { success: true, message: "Bybit credentials validated successfully" };
    } catch (e: any) {
      return { success: false, message: e.message || "Network error during validation" };
    }
  }

  async fetchMarketData(): Promise<MarketTicker[]> {
    try {
      const [tickersResponse, instrumentsResponse] = await Promise.all([
        fetch(`${this.getRestUrl()}/v5/market/tickers?category=spot`),
        fetch(`${this.getRestUrl()}/v5/market/instruments-info?category=spot`),
      ]);

      if (!tickersResponse.ok || !instrumentsResponse.ok) {
        return [];
      }

      const tickersData = await tickersResponse.json() as any;
      const instrumentsData = await instrumentsResponse.json() as any;

      if (tickersData.retCode !== 0 || !Array.isArray(tickersData.result?.list)) {
        return [];
      }

      const minNotionalMap = new Map<string, number>();
      for (const instrument of instrumentsData.result?.list ?? []) {
        const symbol = instrument.symbol;
        const lotSize = instrument.lotSizeFilter ?? {};
        const minOrderQty = parseFloat(lotSize.minOrderQty ?? "0");
        const minOrderAmt = parseFloat(lotSize.minOrderAmt ?? "0");
        if (symbol && (minOrderAmt > 0 || minOrderQty > 0)) {
          minNotionalMap.set(symbol, minOrderAmt || minOrderQty);
        }
      }

      return tickersData.result.list
        .filter((item: any) => item.symbol.endsWith("USDT"))
        .slice(0, 50)
        .map((item: any) => ({
          symbol: item.symbol.replace("USDT", ""),
          price: parseFloat(item.lastPrice || 0),
          volume24h: parseFloat(item.volume24h || 0),
          quoteVolume24h: parseFloat(item.volume24h || 0) * parseFloat(item.lastPrice || 0),
          priceChange24h: parseFloat(item.priceChange || 0),
          priceChangePercent24h: parseFloat(item.priceChangePercent || 0),
          highPrice24h: parseFloat(item.highPrice24h || 0),
          lowPrice24h: parseFloat(item.lowPrice24h || 0),
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
        `${this.getRestUrl()}/v5/market/tickers?category=spot&symbol=${encodeURIComponent(symbol.toUpperCase())}USDT`,
      );
      if (!response.ok) return null;
      const data = await response.json() as any;
      if (data.retCode !== 0 || !Array.isArray(data.result?.list) || data.result.list.length === 0) {
        return null;
      }
      const item = data.result.list[0];
      return {
        symbol: item.symbol.replace("USDT", ""),
        price: parseFloat(item.lastPrice || 0),
        volume24h: parseFloat(item.volume24h || 0),
        quoteVolume24h: parseFloat(item.volume24h || 0) * parseFloat(item.lastPrice || 0),
        priceChange24h: parseFloat(item.priceChange || 0),
        priceChangePercent24h: parseFloat(item.priceChangePercent || 0),
        highPrice24h: parseFloat(item.highPrice24h || 0),
        lowPrice24h: parseFloat(item.lowPrice24h || 0),
        minNotional: 0,
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

  async placeOrder(symbol: string, side: 'BUY' | 'SELL', apiKey: string, apiSecret: string, _quantity?: number): Promise<OrderResult> {
    try {
      const timestamp = Date.now().toString();
      const recvWindow = "5000";
      const orderId = crypto.randomUUID();
      const body = JSON.stringify({
        category: "spot",
        symbol: `${symbol.toUpperCase()}USDT`,
        side: side === "BUY" ? "Buy" : "Sell",
        orderType: "MARKET",
        qty: "0.001",
        orderLinkId: orderId,
      });

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
        return { success: false, message: data.retMsg || "Order failed" };
      }

      return {
        success: true,
        message: "Order placed successfully",
        orderId: data.result?.orderId,
        price: parseFloat(data.result?.avgPrice || 0),
        quantity: parseFloat(data.result?.qty || 0),
      };
    } catch (e: any) {
      return { success: false, message: e.message || "Network error during order placement" };
    }
  }
}
