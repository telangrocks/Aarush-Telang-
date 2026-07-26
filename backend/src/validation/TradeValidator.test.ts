import { describe, it, expect } from "vitest";
import { TradeValidator } from "./TradeValidator";
import { SymbolTradingRules, ValidationErrorReason } from "../exchanges/types";

const mockBtcRules: SymbolTradingRules = {
  schemaVersion: "2.0",
  symbol: "BTCUSDT",
  exchange: "binance",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  minNotional: 10.0,
  minQty: 0.00001,
  maxQty: 1000.0,
  stepSize: 0.00001,
  tickSize: 0.1,
  minPrice: 0.1,
  maxPrice: 1000000.0,
  contractSize: 1.0,
  maxLeverage: 125,
  lastUpdated: Date.now(),
};

describe("TradeValidator TypeScript Unit Tests", () => {
  it("should fail validation when metadata rules are missing", () => {
    const res = TradeValidator.validate({ symbol: "BTCUSDT", entryPrice: 50000 }, null);
    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe(ValidationErrorReason.EXCHANGE_METADATA_UNAVAILABLE);
  });

  it("should fail validation for non-positive entry price", () => {
    const res = TradeValidator.validate({ symbol: "BTCUSDT", entryPrice: -100, tradeValueUsdt: 50 }, mockBtcRules);
    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe(ValidationErrorReason.INVALID_INPUT_PARAMETERS);
  });

  it("should fail validation when order notional is below minimum notional requirement", () => {
    // $5 USDT is below minNotional of $10 USDT
    const res = TradeValidator.validate({ symbol: "BTCUSDT", entryPrice: 50000, tradeValueUsdt: 5.0 }, mockBtcRules);
    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe(ValidationErrorReason.MIN_NOTIONAL_FAILED);
    expect(res.errorMessage).toContain("below exchange minimum notional requirement of $10.00 USDT");
  });

  it("should pass validation when order notional equals or exceeds minimum notional requirement", () => {
    // $20 USDT is above minNotional of $10 USDT
    const res = TradeValidator.validate({ symbol: "BTCUSDT", entryPrice: 50000, tradeValueUsdt: 20.0 }, mockBtcRules);
    expect(res.isValid).toBe(true);
    expect(res.quantizedQuantity).toBeGreaterThan(0);
    expect(res.postRoundingNotional).toBeGreaterThanOrEqual(10.0);
  });

  it("should fail validation when quantity is below minQty", () => {
    // 0.000001 BTC is below minQty 0.00001 BTC
    const res = TradeValidator.validate({ symbol: "BTCUSDT", entryPrice: 50000, quantity: 0.000001 }, mockBtcRules);
    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe(ValidationErrorReason.MIN_QTY_FAILED);
  });

  it("should floor-quantize quantity to exact stepSize precision", () => {
    // Raw qty 0.000329 with stepSize 0.00001 -> quantizes to 0.00032 ($16 USDT > minNotional $10 USDT)
    const res = TradeValidator.validate({ symbol: "BTCUSDT", entryPrice: 50000, quantity: 0.000329 }, mockBtcRules);
    expect(res.isValid).toBe(true);
    expect(res.quantizedQuantity).toBeCloseTo(0.00032, 6);
  });

  it("should fail validation when requested leverage exceeds maxLeverage", () => {
    const res = TradeValidator.validate({ symbol: "BTCUSDT", entryPrice: 50000, tradeValueUsdt: 100, leverage: 150 }, mockBtcRules);
    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe(ValidationErrorReason.LEVERAGE_LIMIT_FAILED);
  });
});
