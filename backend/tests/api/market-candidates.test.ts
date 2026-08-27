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

  it("should filter comprehensive stablecoins and rank remaining top candidates", async () => {
    const inputTickers = [
      { symbol: "USDT", quoteVolume24h: 100_000_000, priceChangePercent24h: 0 },
      { symbol: "USDC", quoteVolume24h: 50_000_000, priceChangePercent24h: 0 },
      { symbol: "USDE", quoteVolume24h: 30_000_000, priceChangePercent24h: 0 },
      { symbol: "PYUSD", quoteVolume24h: 20_000_000, priceChangePercent24h: 0 },
      { symbol: "FRAX", quoteVolume24h: 10_000_000, priceChangePercent24h: 0 },
      { symbol: "DAI/USDT", quoteVolume24h: 15_000_000, priceChangePercent24h: 0 },
      { symbol: "BTC", quoteVolume24h: 500_000_000, priceChangePercent24h: 2.5 },
      { symbol: "ETH", quoteVolume24h: 300_000_000, priceChangePercent24h: 1.8 },
      { symbol: "SOL", quoteVolume24h: 200_000_000, priceChangePercent24h: 4.2 },
    ];

    const result = await analyzeMarket(inputTickers, mockAdapter);
    expect(result.length).toBe(3);
    const symbols = result.map((c) => c.symbol);
    expect(symbols).not.toContain("USDT");
    expect(symbols).not.toContain("USDC");
    expect(symbols).not.toContain("USDE");
    expect(symbols).not.toContain("PYUSD");
    expect(symbols).not.toContain("FRAX");
    expect(symbols).not.toContain("DAI/USDT");
    expect(symbols).toContain("BTC");
    expect(symbols).toContain("ETH");
    expect(symbols).toContain("SOL");
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
    expect(result[2].rank).toBe(3);
  });

  it("should filter comprehensive leveraged tokens", async () => {
    const inputTickers = [
      { symbol: "BTC3L", quoteVolume24h: 5_000_000, priceChangePercent24h: 6.0 },
      { symbol: "ETH3S", quoteVolume24h: 5_000_000, priceChangePercent24h: -6.0 },
      { symbol: "SOL10L", quoteVolume24h: 5_000_000, priceChangePercent24h: 12.0 },
      { symbol: "BTCUP", quoteVolume24h: 5_000_000, priceChangePercent24h: 4.0 },
      { symbol: "BTCDOWN", quoteVolume24h: 5_000_000, priceChangePercent24h: -4.0 },
      { symbol: "ETHBULL", quoteVolume24h: 5_000_000, priceChangePercent24h: 5.0 },
      { symbol: "ETHBEAR", quoteVolume24h: 5_000_000, priceChangePercent24h: -5.0 },
      { symbol: "AVAX", quoteVolume24h: 10_000_000, priceChangePercent24h: 3.5 },
    ];

    const result = await analyzeMarket(inputTickers, mockAdapter);
    expect(result.length).toBe(1);
    expect(result[0].symbol).toBe("AVAX");
  });

  it("should fail closed on zero or missing volume when other liquid candidates exist", async () => {
    const inputTickers = [
      { symbol: "BTC", quoteVolume24h: 50_000_000, priceChangePercent24h: 1.2 },
      { symbol: "NOVOL", quoteVolume24h: 0, priceChangePercent24h: 5.0 },
      { symbol: "MISSINGVOL", priceChangePercent24h: 8.0 },
    ];

    const result = await analyzeMarket(inputTickers, mockAdapter);
    expect(result.length).toBe(1);
    expect(result[0].symbol).toBe("BTC");
  });

  it("should fallback gracefully if all candidates have zero reported volume", async () => {
    const inputTickers = [
      { symbol: "BTC", priceChangePercent24h: 1.2 },
      { symbol: "ETH", priceChangePercent24h: 0.8 },
    ];

    const result = await analyzeMarket(inputTickers, mockAdapter);
    expect(result.length).toBe(2);
    expect(result[0].symbol).toBe("BTC");
    expect(result[1].symbol).toBe("ETH");
  });

  it("should resolve conflicting 1h and 15m signals strictly to NEUTRAL", async () => {
    // Generate 100 upward-trending candles for 1h (BUY)
    const bullishKlines1h = Array.from({ length: 100 }, (_, i) => ({
      openTime: 1000 + i * 3600000,
      close: 100 + i * 2, // Strong uptrend: EMA20 > EMA50, RSI > 50
    }));

    // Generate 100 downward-trending candles for 15m (SELL)
    const bearishKlines15m = Array.from({ length: 100 }, (_, i) => ({
      openTime: 1000 + i * 900000,
      close: 500 - i * 2, // Strong downtrend: EMA20 < EMA50, RSI < 50
    }));

    const adapterWithConflict = {
      fetchKlines: async (_sym: string, interval: string) => {
        if (interval === "1h") return bullishKlines1h;
        return bearishKlines15m;
      },
    } as unknown as IExchangeProvider;

    const inputTickers = [
      { symbol: "CONFLICT_COIN", quoteVolume24h: 5_000_000, priceChangePercent24h: 1.0 },
    ];

    const result = await analyzeMarket(inputTickers, adapterWithConflict);
    expect(result.length).toBe(1);
    expect(result[0].tradeSide).toBe("NEUTRAL");
  });

  it("should assign BUY when both 1h and 15m indicators are bullish", async () => {
    const bullishKlines = Array.from({ length: 100 }, (_, i) => ({
      openTime: 1000 + i * 3600000,
      close: 100 + i * 2, // Strong uptrend
    }));

    const adapterBullish = {
      fetchKlines: async () => bullishKlines,
    } as unknown as IExchangeProvider;

    const inputTickers = [
      { symbol: "APT", quoteVolume24h: 5_000_000, priceChangePercent24h: 2.0 },
    ];

    const result = await analyzeMarket(inputTickers, adapterBullish);
    expect(result.length).toBe(1);
    expect(result[0].tradeSide).toBe("BUY");
  });

  it("should assign SELL when both 1h and 15m indicators are bearish", async () => {
    const bearishKlines = Array.from({ length: 100 }, (_, i) => ({
      openTime: 1000 + i * 3600000,
      close: 500 - i * 2, // Strong downtrend
    }));

    const adapterBearish = {
      fetchKlines: async () => bearishKlines,
    } as unknown as IExchangeProvider;

    const inputTickers = [
      { symbol: "NEAR", quoteVolume24h: 5_000_000, priceChangePercent24h: -2.0 },
    ];

    const result = await analyzeMarket(inputTickers, adapterBearish);
    expect(result.length).toBe(1);
    expect(result[0].tradeSide).toBe("SELL");
  });

  it("should limit output to top 10 candidates and rank deterministically", async () => {
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
