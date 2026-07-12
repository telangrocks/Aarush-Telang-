import { IExchangeAdapter, ValidationResult, MarketTicker } from "./BaseExchange";
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
      const response = await fetch(`${this.config.restUrl}/api/v3/ticker/24hr`);
      if (!response.ok) {
        return [];
      }
      const data = await response.json() as any;
      return data
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
        }));
    } catch {
      return [];
    }
  }
}
