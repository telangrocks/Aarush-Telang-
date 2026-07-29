import { describe, it, expect } from "vitest";
import { analyzeMarket } from "../../src/market-analysis";
import { IExchangeProvider } from "../../src/exchanges/IExchangeProvider";

const mockAdapter = {
  fetchKlines: async () => [],
} as unknown as IExchangeProvider;

describe("Market Candidates Analysis Engine", () => {
  it("should return empty array when input tickers array is empty", async () => {
    const result = await analyzeMarket([], mockAdapter);
    expect(result).toEqual([]);
  });

  it("should filter stablecoins and rank remaining top candidates", async () => {
    const inputTickers = [
      { symbol: "USDT", quoteVolume24h: 100_000_000, priceChangePercent24h: 0 },
      { symbol: "USDC", quoteVolume24h: 50_000_000, priceChangePercent24h: 0 },
      { symbol: "BTC", quoteVolume24h: 500_000_000, priceChangePercent24h: 2.5 },
      { symbol: "ETH", quoteVolume24h: 300_000_000, priceChangePercent24h: 1.8 },
      { symbol: "SOL", quoteVolume24h: 200_000_000, priceChangePercent24h: 4.2 },
    ];

    const result = await analyzeMarket(inputTickers, mockAdapter);
    expect(result.length).toBe(3);
    expect(result.map((c) => c.symbol)).not.toContain("USDT");
    expect(result.map((c) => c.symbol)).not.toContain("USDC");
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
    expect(result[2].rank).toBe(3);
  });

  it("should apply safe volume defaults when volume fields are missing", async () => {
    const inputTickers = [
      { symbol: "BTC", priceChangePercent24h: 1.2 },
      { symbol: "ETH", priceChangePercent24h: 0.8 },
    ];

    const result = await analyzeMarket(inputTickers, mockAdapter);
    expect(result.length).toBe(2);
    expect(result[0].symbol).toBe("BTC");
    expect(result[1].symbol).toBe("ETH");
  });

  it("should limit output to top 10 candidates", async () => {
    const inputTickers = Array.from({ length: 20 }, (_, i) => ({
      symbol: `COIN${i}`,
      quoteVolume24h: (20 - i) * 1_000_000,
      priceChangePercent24h: (20 - i) * 0.5,
    }));

    const result = await analyzeMarket(inputTickers, mockAdapter);
    expect(result.length).toBe(10);
    expect(result[0].rank).toBe(1);
    expect(result[9].rank).toBe(10);
  });
});
