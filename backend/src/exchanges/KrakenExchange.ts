import { IExchangeAdapter, ValidationResult, MarketTicker } from "./BaseExchange";
import { ExchangeConfig } from "./types";

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
  };

  getName() {
    return this.config.displayName;
  }

  async validateCredentials(apiKey: string, apiSecret: string): Promise<ValidationResult> {
    try {
      const nonce = Date.now().toString();
      const body = `nonce=${nonce}&otp=`;
      const path = "/0/private/Balance";

      const signature = base64Encode(await hmacSha512(path + btoa(nonce) + btoa(body), apiSecret));

      const response = await fetch(`${this.config.restUrl}${path}`, {
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
      const response = await fetch(`${this.config.restUrl}/0/public/Ticker?pair=${pairs}`);
      if (!response.ok) {
        return [];
      }
      const data = await response.json() as any;
      if (data.error && data.error.length > 0) {
        return [];
      }
      const result = data.result || {};
      return Object.values(result).map((item: any) => {
        const symbol = item.wsname?.split("/")[0] || Object.keys(result)[0];
        return {
          symbol,
          price: parseFloat(item.c?.[0] || item.p?.[1] || 0),
          volume24h: parseFloat(item.v?.[1] || 0),
          priceChange24h: parseFloat(item.p?.[1] || 0) - parseFloat(item.p?.[0] || item.p?.[1] || 0),
          priceChangePercent24h: 0,
          highPrice24h: parseFloat(item.h?.[1] || 0),
          lowPrice24h: parseFloat(item.l?.[1] || 0),
        };
      });
    } catch {
      return [];
    }
  }
}
