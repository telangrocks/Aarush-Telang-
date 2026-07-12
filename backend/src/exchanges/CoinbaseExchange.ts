import { IExchangeAdapter, ValidationResult, MarketTicker } from "./BaseExchange";
import { ExchangeConfig } from "./types";

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
  };

  getName() {
    return this.config.displayName;
  }

  async validateCredentials(apiKey: string, apiSecret: string): Promise<ValidationResult> {
    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const method = "GET";
      const requestPath = "/api/v3/brokerage/accounts";
      const body = "";

      const message = timestamp + method + requestPath + body;
      const signature = base64Encode(await hmacSha256(message, apiSecret));

      const response = await fetch(`${this.config.restUrl}${requestPath}`, {
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

      for (const pair of pairs) {
        try {
          const response = await fetch(`${this.config.restUrl}/v2/prices/${pair}/spot`);
          if (!response.ok) continue;
          const data = await response.json() as any;
          const price = parseFloat(data.data.amount);
          if (price > 0) {
            results.push({
              symbol: pair.split("-")[0],
              price,
              volume24h: 0,
              priceChange24h: 0,
              priceChangePercent24h: 0,
              highPrice24h: price * 1.02,
              lowPrice24h: price * 0.98,
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
}
