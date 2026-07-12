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

export class BybitExchange implements IExchangeAdapter {
  readonly config: ExchangeConfig = {
    name: "bybit",
    displayName: "Bybit",
    restUrl: "https://api.bybit.com",
  };

  getName() {
    return this.config.displayName;
  }

  async validateCredentials(apiKey: string, apiSecret: string): Promise<ValidationResult> {
    try {
      const timestamp = new Date().toISOString();
      const recvWindow = "5000";
      const query = `timestamp=${encodeURIComponent(timestamp)}&recv_window=${recvWindow}`;
      const signature = await hmacSha256(timestamp + apiKey + recvWindow + query, apiSecret);

      const response = await fetch(`${this.config.restUrl}/v5/account/info?${query}`, {
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
        fetch(`${this.config.restUrl}/v5/market/tickers?category=spot`),
        fetch(`${this.config.restUrl}/v5/market/instruments-info?category=spot`),
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
}
