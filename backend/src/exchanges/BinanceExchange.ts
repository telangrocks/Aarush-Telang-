import { IExchangeAdapter, ValidationResult, MarketTicker, OrderResult } from "./BaseExchange";
import { ExchangeConfig } from "./types";

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
    restUrl: "https://api.binance.com",
  };

  getName() {
    return this.config.displayName;
  }

  async validateCredentials(apiKey: string, apiSecret: string): Promise<ValidationResult> {
    try {
      const timestamp = Date.now();
      const query = `timestamp=${timestamp}`;
      const signature = await hmacSha256(query, apiSecret);
      const url = `${this.config.restUrl}/api/v3/account?${query}&signature=${signature}`;

      const response = await fetch(url, {
        headers: {
          "X-MBX-APIKEY": apiKey,
        },
      });

      if (!response.ok) {
        const body = await response.text();
        return { success: false, message: `HTTP ${response.status}: ${body}` };
      }

      const data = await response.json() as any;
      if (data.code && data.code !== 0) {
        return { success: false, message: data.msg || "Invalid API credentials" };
      }

      return { success: true, message: "Binance credentials validated successfully" };
    } catch (e: any) {
      return { success: false, message: e.message || "Network error during validation" };
    }
  }

  async fetchMarketData(): Promise<MarketTicker[]> {
    try {
      const [tickersResponse, exchangeInfoResponse] = await Promise.all([
        fetch(`${this.config.restUrl}/api/v3/ticker/24hr`),
        fetch(`${this.config.restUrl}/api/v3/exchangeInfo`),
      ]);

      if (!tickersResponse.ok || !exchangeInfoResponse.ok) {
        return [];
      }

      const tickers = await tickersResponse.json() as any[];
      const exchangeInfo = await exchangeInfoResponse.json() as any;

      const minNotionalMap = new Map<string, number>();
      for (const symbol of exchangeInfo.symbols ?? []) {
        const filters = symbol.filters ?? [];
        const notionalFilter = filters.find((f: any) => f.filterType === "NOTIONAL");
        if (notionalFilter && symbol.status === "TRADING") {
          minNotionalMap.set(symbol.symbol, parseFloat(notionalFilter.minNotional || "0"));
        }
      }

      return tickers
        .filter((item: any) => item.symbol.endsWith("USDT") || item.symbol.endsWith("BUSD"))
        .slice(0, 50)
        .map((item: any) => ({
          symbol: item.symbol.replace(/USDT|BUSD$/, ""),
          price: parseFloat(item.lastPrice),
          volume24h: parseFloat(item.volume),
          priceChange24h: parseFloat(item.priceChange),
          priceChangePercent24h: parseFloat(item.priceChangePercent),
          highPrice24h: parseFloat(item.highPrice),
          lowPrice24h: parseFloat(item.lowPrice),
          minNotional: minNotionalMap.get(item.symbol) || 0,
        }));
    } catch {
      return [];
    }
  }

  async placeOrder(symbol: string, side: 'BUY' | 'SELL', apiKey: string, apiSecret: string, _quantity?: number): Promise<OrderResult> {
    try {
      const timestamp = Date.now();
      const recvWindow = 5000;
      const fullSymbol = `${symbol.toUpperCase()}USDT`;
      
      const orderParams = new URLSearchParams({
        symbol: fullSymbol,
        side: side,
        type: 'MARKET',
        quoteOrderQty: '10',
      });

      const queryString = `timestamp=${timestamp}&recvWindow=${recvWindow}&${orderParams.toString()}`;
      const signature = await hmacSha256(queryString, apiSecret);
      const url = `${this.config.restUrl}/api/v3/order?${queryString}&signature=${signature}`;

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
        return { 
          success: false, 
          message: data.msg || `HTTP ${response.status}: Order failed` 
        };
      }

      return {
        success: true,
        message: `Order placed successfully`,
        orderId: data.orderId?.toString(),
        price: parseFloat(data.fills?.[0]?.price || '0'),
        quantity: parseFloat(data.fills?.[0]?.qty || '0'),
      };
    } catch (e: any) {
      return { success: false, message: e.message || 'Network error during order placement' };
    }
  }
}
