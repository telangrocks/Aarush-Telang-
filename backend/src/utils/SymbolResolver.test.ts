import { describe, it, expect } from "vitest";
import { SymbolResolver } from "./SymbolResolver";

describe("SymbolResolver Unit Tests", () => {
  it("should normalize lowercase base asset 'btc' to BTCUSDT", () => {
    const res = SymbolResolver.resolve("btc");
    expect(res.symbol).toBe("BTCUSDT");
    expect(res.baseAsset).toBe("BTC");
    expect(res.quoteAsset).toBe("USDT");
  });

  it("should normalize uppercase base asset 'BTC' to BTCUSDT", () => {
    const res = SymbolResolver.resolve("BTC");
    expect(res.symbol).toBe("BTCUSDT");
    expect(res.baseAsset).toBe("BTC");
    expect(res.quoteAsset).toBe("USDT");
  });

  it("should parse slash notation 'BTC/USDT' correctly", () => {
    const res = SymbolResolver.resolve("BTC/USDT");
    expect(res.symbol).toBe("BTCUSDT");
    expect(res.baseAsset).toBe("BTC");
    expect(res.quoteAsset).toBe("USDT");
  });

  it("should parse hyphen notation 'SOL-USDT' correctly", () => {
    const res = SymbolResolver.resolve("SOL-USDT");
    expect(res.symbol).toBe("SOLUSDT");
    expect(res.baseAsset).toBe("SOL");
    expect(res.quoteAsset).toBe("USDT");
  });

  it("should handle full symbol string 'ETHUSDT'", () => {
    const res = SymbolResolver.resolve("ETHUSDT");
    expect(res.symbol).toBe("ETHUSDT");
    expect(res.baseAsset).toBe("ETH");
    expect(res.quoteAsset).toBe("USDT");
  });

  it("should handle lowercase full symbol 'dogeusdt'", () => {
    const res = SymbolResolver.resolve("dogeusdt");
    expect(res.symbol).toBe("DOGEUSDT");
    expect(res.baseAsset).toBe("DOGE");
    expect(res.quoteAsset).toBe("USDT");
  });

  it("should support custom default quote asset", () => {
    const res = SymbolResolver.resolve("BTC", "USD");
    expect(res.symbol).toBe("BTCUSD");
    expect(res.baseAsset).toBe("BTC");
    expect(res.quoteAsset).toBe("USD");
  });

  it("should throw error for empty or non-string inputs", () => {
    expect(() => SymbolResolver.resolve("")).toThrow();
    expect(() => SymbolResolver.resolve(null as any)).toThrow();
  });
});
