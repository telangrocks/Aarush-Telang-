import { IExchangeAdapter, ValidationResult, MarketTicker, Kline, OrderResult } from "./BaseExchange";
import { ExchangeConfig, ExchangeEnvironment } from "./types";

async function hmacSha256(message: string, secret: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
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

export class CoinbaseExchange implements IExchangeAdapter {
  readonly config: ExchangeConfig = {
    name: "coinbase",
    displayName: "Coinbase Advanced Trade",
    restUrl: "https://api.coinbase.com",
    testnetUrl: "https://api.sandbox.coinbase.com",
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
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const method = "GET";
      const requestPath = "/api/v3/brokerage/accounts";
      const body = "";

      const message = timestamp + method + requestPath + body;
      const signature = base64Encode(await hmacSha256(message, apiSecret));

      const response = await fetch(`${this.getRestUrl()}${requestPath}`, {
        method: "GET",
        headers: {
          "CB-ACCESS-KEY": apiKey,
          "CB-ACCESS-SIGN": signature,
          "CB-ACCESS-TIMESTAMP": timestamp,
        },
      });

      if (!response.ok) {
        const bodyText = await response.text();
        return { success: false, message: `HTTP ${response.status}: ${bodyText}` };
      }

      const data = await response.json() as any;
      if (data.error || data.errors) {
        const errMsg = Array.isArray(data.error) ? data.error[0]?.message : data.error?.message;
        return { success: false, message: errMsg || "Invalid API credentials" };
      }

      return { success: true, message: "Coinbase credentials validated successfully" };
    } catch (e: any) {
      return { success: false, message: e.message || "Network error during validation" };
    }
  }

  async fetchMarketData(): Promise<MarketTicker[]> {
    try {
      const pairs = ["BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD", "DOGE-USD", "ADA-USD", "AVAX-USD", "DOT-USD", "LINK-USD", "MATIC-USD", "NEAR-USD"];
      const results: MarketTicker[] = [];

      const minNotionalMap = new Map<string, number>();
      try {
        const productsResponse = await fetch(`${this.getRestUrl()}/api/v3/brokerage/products`);
        if (productsResponse.ok) {
          const productsData = await productsResponse.json() as any;
          for (const product of productsData.products ?? []) {
            const symbol = product.product_id?.replace("-USD", "") || product.base_name;
            const minQuoteSize = parseFloat(product.min_quote_size ?? "0");
            const minBaseSize = parseFloat(product.min_base_size ?? "0");
            if (symbol && minQuoteSize > 0) {
              minNotionalMap.set(symbol, minQuoteSize);
            } else if (symbol && minBaseSize > 0) {
              minNotionalMap.set(symbol, minBaseSize);
            }
          }
        }
      } catch {
        // Continue with empty map if products fetch fails
      }

      for (const pair of pairs) {
        try {
          const symbol = pair.split("-")[0];
          let price = 0;
          let priceChangePercent24h = 0;
          let priceChange24h = 0;
          let highPrice24h = 0;
          let lowPrice24h = 0;
          let volume24h = 0;

          const candlesResponse = await fetch(
            `${this.getRestUrl()}/api/v3/brokerage/products/${pair}/candles?granularity=3600&limit=24`,
          );
          if (candlesResponse.ok) {
            const candlesData = await candlesResponse.json() as any;
            const candles: any[] = candlesData.candles ?? [];
            if (candles.length > 0) {
              // Coinbase candles: [start, low, high, open, close, volume], newest first.
              const opens = candles.map((c) => parseFloat(c[3]));
              const closes = candles.map((c) => parseFloat(c[4]));
              const lows = candles.map((c) => parseFloat(c[1]));
              const highs = candles.map((c) => parseFloat(c[2]));
              const volumes = candles.map((c) => parseFloat(c[5]));
              const firstOpen = opens[opens.length - 1];
              const lastClose = closes[0];
              price = lastClose;
              highPrice24h = Math.max(...highs);
              lowPrice24h = Math.min(...lows);
              volume24h = volumes.reduce((a, b) => a + b, 0);
              if (firstOpen > 0) {
                priceChangePercent24h = ((lastClose - firstOpen) / firstOpen) * 100;
                priceChange24h = lastClose - firstOpen;
              }
            }
          }

          if (price <= 0) {
            const priceResponse = await fetch(`${this.getRestUrl()}/v2/prices/${pair}/spot`);
            if (priceResponse.ok) {
              const pd = await priceResponse.json() as any;
              price = parseFloat(pd.data?.amount || 0);
            }
          }

          if (price > 0) {
            results.push({
              symbol,
              price,
              volume24h,
              priceChange24h,
              priceChangePercent24h,
              highPrice24h: highPrice24h || price * 1.02,
              lowPrice24h: lowPrice24h || price * 0.98,
              minNotional: minNotionalMap.get(symbol) || 0,
            });
          }
        } catch {
          continue;
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  async fetchTicker(symbol: string): Promise<MarketTicker | null> {
    try {
      if (!/^[A-Za-z0-9]+$/.test(symbol)) {
        return null;
      }
      const productId = `${symbol.toUpperCase()}-USD`;
      const response = await fetch(
        `${this.getRestUrl()}/api/v3/brokerage/products/${encodeURIComponent(productId)}`,
      );
      if (!response.ok) return null;
      const data = await response.json() as any;
      const item = data?.product;
      if (!item || !item.product_id) return null;
      const price = parseFloat(item.price || item.current_price || 0);
      return {
        symbol: item.product_id.replace("-USD", ""),
        price,
        volume24h: parseFloat(item.volume_24h || 0),
        priceChange24h: 0,
        priceChangePercent24h: parseFloat(item.price_percentage_change_24h || 0),
        highPrice24h: price,
        lowPrice24h: price,
        minNotional: 0,
      };
    } catch {
      return null;
    }
  }

  async fetchKlines(symbol: string, _interval: string, _limit: number): Promise<Kline[]> {
    try {
      const pair = `${symbol.toUpperCase()}-USD`;
      const response = await fetch(`${this.getRestUrl()}/api/v3/brokerage/products/${pair}/candles`);
      if (!response.ok) return [];
      const data = await response.json() as any;
      if (data.error || data.errors || !Array.isArray(data.candles)) return [];
      return data.candles.map((k: any[]) => ({
        openTime: parseInt(k[0]),
        open: parseFloat(k[3]),
        high: parseFloat(k[2]),
        low: parseFloat(k[1]),
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
      const method = "POST";
      const requestPath = "/api/v3/brokerage/orders";
      const body = JSON.stringify({
        client_order_id: crypto.randomUUID(),
        product_id: `${symbol.toUpperCase()}-USD`,
        side: side === "BUY" ? "BUY" : "SELL",
        order_configuration: {
          market_market_ioc: {
            quote_size: "10",
          },
        },
      });
      const message = timestamp + method + requestPath + body;
      const signature = base64Encode(await hmacSha256(message, apiSecret));

      const response = await fetch(`${this.getRestUrl()}${requestPath}`, {
        method: "POST",
        headers: {
          "CB-ACCESS-KEY": apiKey,
          "CB-ACCESS-SIGN": signature,
          "CB-ACCESS-TIMESTAMP": timestamp,
          "Content-Type": "application/json",
        },
        body,
      });

      const data = await response.json() as any;
      if (data.error || data.errors) {
        return { success: false, message: data.error?.[0]?.message || data.errors?.[0] || "Order failed" };
      }

      return {
        success: true,
        message: "Order placed successfully",
        orderId: data.order?.id,
        price: parseFloat(data.order?.average_price || 0),
        quantity: parseFloat(data.order?.filled_size || 0),
      };
    } catch (e: any) {
      return { success: false, message: e.message || "Network error during order placement" };
    }
  }
}
