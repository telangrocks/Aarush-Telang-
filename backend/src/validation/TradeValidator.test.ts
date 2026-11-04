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

  describe("Bybit Maximum Quantity Handling & Regression Tests", () => {
    const mock1000PepeRules: SymbolTradingRules = {
      schemaVersion: "2.0",
      symbol: "1000PEPEUSDT",
      exchange: "bybit",
      baseAsset: "1000PEPE",
      quoteAsset: "USDT",
      minNotional: 5.0,
      minQty: 100.0,
      maxQty: 999999.0,
      stepSize: 100.0,
      tickSize: 0.000001,
      minPrice: 0.000001,
      maxPrice: 1000.0,
      contractSize: 1.0,
      lastUpdated: Date.now(),
    };

    it("reproduces and corrects the original 1000PEPE case: $5,555 budget at $0.004962 clamps to 999,900 contracts", () => {
      // Requested budget: $5,555.00 USDT
      // Entry price: $0.004962
      // Raw quantity: 5555 / 0.004962 = 1,119,508.26...
      // Bybit maxOrderQty: 999,999
      // Quantity step: 100
      // Clamped & quantized: floor(999,999 / 100) * 100 = 999,900 contracts
      // Approximate notional: 999,900 * 0.004962 = $4,961.5038 USDT
      const res = TradeValidator.validate(
        {
          symbol: "1000PEPEUSDT",
          entryPrice: 0.004962,
          tradeValueUsdt: 5555.0,
        },
        mock1000PepeRules
      );

      expect(res.isValid).toBe(true);
      expect(res.quantizedQuantity).toBe(999900);
      expect(res.wasClampedToMax).toBe(true);
      expect(res.postRoundingNotional).toBeCloseTo(4961.5038, 2);
      expect(res.postRoundingNotional).toBeLessThanOrEqual(5555.0); // Never exceeds user budget!
      expect(res.quantizedQuantity).toBeLessThanOrEqual(mock1000PepeRules.maxQty!); // Never exceeds Bybit maxQty!
    });

    it("accepts quantity below exchange maximum without clamping", () => {
      // Budget: $1,000 USDT on 1000PEPE -> raw ~201,531 -> quantized 201,500 (< 999,999)
      const res = TradeValidator.validate(
        {
          symbol: "1000PEPEUSDT",
          entryPrice: 0.004962,
          tradeValueUsdt: 1000.0,
        },
        mock1000PepeRules
      );

      expect(res.isValid).toBe(true);
      expect(res.quantizedQuantity).toBe(201500);
      expect(res.wasClampedToMax).toBe(false);
      expect(res.postRoundingNotional).toBeCloseTo(999.843, 2);
    });

    it("accepts quantity exactly at exchange maximum when step-valid", () => {
      const stepValidRules: SymbolTradingRules = {
        ...mock1000PepeRules,
        maxQty: 1000000.0, // Exact multiple of stepSize 100
      };

      const res = TradeValidator.validate(
        {
          symbol: "1000PEPEUSDT",
          entryPrice: 0.004962,
          quantity: 1000000.0,
        },
        stepValidRules
      );

      expect(res.isValid).toBe(true);
      expect(res.quantizedQuantity).toBe(1000000);
      expect(res.wasClampedToMax).toBe(false);
    });

    it("safely adjusts quantity above maximum before confirmation", () => {
      // Direct quantity passed as 1,500,000 contracts (exceeds 999,999)
      const res = TradeValidator.validate(
        {
          symbol: "1000PEPEUSDT",
          entryPrice: 0.004962,
          quantity: 1500000.0,
        },
        mock1000PepeRules
      );

      expect(res.isValid).toBe(true);
      expect(res.quantizedQuantity).toBe(999900);
      expect(res.wasClampedToMax).toBe(true);
      expect(res.quantizedQuantity).toBeLessThanOrEqual(mock1000PepeRules.maxQty!);
    });

    it("rounds down correctly using qtyStep when maxQty is not an integer multiple of step", () => {
      const oddStepRules: SymbolTradingRules = {
        ...mock1000PepeRules,
        maxQty: 500050.0,
        stepSize: 100.0,
      };

      const res = TradeValidator.validate(
        {
          symbol: "1000PEPEUSDT",
          entryPrice: 0.004962,
          quantity: 600000.0,
        },
        oddStepRules
      );

      // floor(500050 / 100) * 100 = 500000
      expect(res.isValid).toBe(true);
      expect(res.quantizedQuantity).toBe(500000);
      expect(res.wasClampedToMax).toBe(true);
    });

    it("rejects when quantity is below minimum order quantity", () => {
      const res = TradeValidator.validate(
        {
          symbol: "1000PEPEUSDT",
          entryPrice: 0.004962,
          quantity: 50.0, // Below minQty 100
        },
        mock1000PepeRules
      );

      expect(res.isValid).toBe(false);
      expect(res.errorCode).toBe(ValidationErrorReason.MIN_QTY_FAILED);
    });

    it("rejects when post-rounding notional drops below minNotional after adjustment", () => {
      const restrictiveRules: SymbolTradingRules = {
        ...mock1000PepeRules,
        minNotional: 100.0,
        maxQty: 1000.0, // Max notional at $0.004962 is only ~$4.96 < minNotional $100
      };

      const res = TradeValidator.validate(
        {
          symbol: "1000PEPEUSDT",
          entryPrice: 0.004962,
          tradeValueUsdt: 5000.0,
        },
        restrictiveRules
      );

      expect(res.isValid).toBe(false);
      expect(res.errorCode).toBe(ValidationErrorReason.MIN_NOTIONAL_FAILED);
    });

    it("fails closed when exchange metadata is missing or null", () => {
      const res = TradeValidator.validate(
        {
          symbol: "1000PEPEUSDT",
          entryPrice: 0.004962,
          tradeValueUsdt: 5555.0,
        },
        null
      );

      expect(res.isValid).toBe(false);
      expect(res.errorCode).toBe(ValidationErrorReason.EXCHANGE_METADATA_UNAVAILABLE);
    });

    it("handles different instrument-specific maximums (SOL vs BONK vs PEPE)", () => {
      const solRules: SymbolTradingRules = {
        schemaVersion: "2.0",
        symbol: "SOLUSDT",
        exchange: "bybit",
        baseAsset: "SOL",
        quoteAsset: "USDT",
        minNotional: 5.0,
        minQty: 0.1,
        maxQty: 10000.0,
        stepSize: 0.1,
        tickSize: 0.01,
        minPrice: 0.01,
        maxPrice: 10000.0,
        contractSize: 1.0,
        lastUpdated: Date.now(),
      };

      // SOL: $5,555 at $95.42 -> 58.2 SOL (< 10,000) -> unclamped
      const solRes = TradeValidator.validate(
        { symbol: "SOLUSDT", entryPrice: 95.42, tradeValueUsdt: 5555.0 },
        solRules
      );
      expect(solRes.isValid).toBe(true);
      expect(solRes.quantizedQuantity).toBe(58.2);
      expect(solRes.wasClampedToMax).toBe(false);

      const bonkRules: SymbolTradingRules = {
        schemaVersion: "2.0",
        symbol: "1000BONKUSDT",
        exchange: "bybit",
        baseAsset: "1000BONK",
        quoteAsset: "USDT",
        minNotional: 5.0,
        minQty: 10.0,
        maxQty: 250000.0,
        stepSize: 10.0,
        tickSize: 0.00001,
        minPrice: 0.00001,
        maxPrice: 100.0,
        contractSize: 1.0,
        lastUpdated: Date.now(),
      };

      // BONK: $6,000 at $0.02 -> 300,000 raw -> clamped to 250,000
      const bonkRes = TradeValidator.validate(
        { symbol: "1000BONKUSDT", entryPrice: 0.02, tradeValueUsdt: 6000.0 },
        bonkRules
      );
      expect(bonkRes.isValid).toBe(true);
      expect(bonkRes.quantizedQuantity).toBe(250000);
      expect(bonkRes.wasClampedToMax).toBe(true);
      expect(bonkRes.postRoundingNotional).toBe(5000.0);
      expect(bonkRes.postRoundingNotional).toBeLessThanOrEqual(6000.0);
    });

    describe("Exact Execution Quantity Consistency & Fail-Closed Metadata Gates", () => {
      it("preserves exact approved quantity during final execution without recalculation or silent modification", () => {
        const res = TradeValidator.validate(
          {
            symbol: "1000PEPEUSDT",
            entryPrice: 0.004962,
            quantity: 999900,
            isApprovedQuantity: true,
          },
          mock1000PepeRules
        );

        expect(res.isValid).toBe(true);
        expect(res.quantizedQuantity).toBe(999900);
        expect(res.postRoundingNotional).toBeCloseTo(4961.5038, 2);
      });

      it("fails closed when approved quantity exceeds exchange maxOrderQty (forbids silent modification)", () => {
        const res = TradeValidator.validate(
          {
            symbol: "1000PEPEUSDT",
            entryPrice: 0.004962,
            quantity: 1500000,
            isApprovedQuantity: true,
          },
          mock1000PepeRules
        );

        expect(res.isValid).toBe(false);
        expect(res.errorCode).toBe(ValidationErrorReason.MAX_QTY_FAILED);
        expect(res.errorMessage).toContain("Fresh confirmation is required");
      });

      it("fails closed when approved quantity is not aligned with qtyStep (forbids silent modification)", () => {
        const res = TradeValidator.validate(
          {
            symbol: "1000PEPEUSDT",
            entryPrice: 0.004962,
            quantity: 999950,
            isApprovedQuantity: true,
          },
          mock1000PepeRules
        );

        expect(res.isValid).toBe(false);
        expect(res.errorCode).toBe(ValidationErrorReason.INVALID_STEP_SIZE);
        expect(res.errorMessage).toContain("Fresh confirmation is required");
      });

      it("fails closed when authoritative maxQty metadata is explicitly invalid (zero, NaN, negative, or Infinity)", () => {
        const invalidRulesList = [
          { ...mock1000PepeRules, maxQty: 0 },
          { ...mock1000PepeRules, maxQty: NaN },
          { ...mock1000PepeRules, maxQty: -100 },
          { ...mock1000PepeRules, maxQty: Infinity },
          { ...mock1000PepeRules, maxQty: -Infinity },
        ];

        for (const badRules of invalidRulesList) {
          const res = TradeValidator.validate(
            {
              symbol: "1000PEPEUSDT",
              entryPrice: 0.004962,
              quantity: 2000,
              isApprovedQuantity: true,
            },
            badRules
          );

          expect(res.isValid).toBe(false);
          expect(res.errorCode).toBe(ValidationErrorReason.EXCHANGE_METADATA_UNAVAILABLE);
          expect(res.errorMessage).toContain("invalid");
        }
      });

      it("fails closed when authoritative marketMaxQty metadata is explicitly invalid (zero, NaN, negative, or Infinity) without falling back to maxQty", () => {
        const invalidMarketRulesList = [
          { ...mock1000PepeRules, maxQty: 1000000, marketMaxQty: 0 },
          { ...mock1000PepeRules, maxQty: 1000000, marketMaxQty: -5 },
          { ...mock1000PepeRules, maxQty: 1000000, marketMaxQty: NaN },
          { ...mock1000PepeRules, maxQty: 1000000, marketMaxQty: Infinity },
          { ...mock1000PepeRules, maxQty: 1000000, marketMaxQty: -Infinity },
        ];

        for (const badRules of invalidMarketRulesList) {
          const res = TradeValidator.validate(
            {
              symbol: "1000PEPEUSDT",
              orderType: "MARKET",
              entryPrice: 0.004962,
              tradeValueUsdt: 100,
            },
            badRules
          );

          expect(res.isValid).toBe(false);
          expect(res.errorCode).toBe(ValidationErrorReason.EXCHANGE_METADATA_UNAVAILABLE);
          expect(res.errorMessage).toContain("marketMaxQty");
        }
      });

      it("independently enforces marketMaxQty for MARKET orders and maxQty for LIMIT orders without cross-contamination", () => {
        const dualMaxRules: SymbolTradingRules = {
          ...mock1000PepeRules,
          maxQty: 1000000,      // LIMIT max = 1,000,000
          marketMaxQty: 200000, // MARKET max = 200,000
        };

        // 1. MARKET order with $2,500 at $0.005 (raw = 500,000) -> clamped to marketMaxQty (200,000)
        const mktRes = TradeValidator.validate(
          {
            symbol: "1000PEPEUSDT",
            orderType: "MARKET",
            entryPrice: 0.005,
            tradeValueUsdt: 2500,
          },
          dualMaxRules
        );
        expect(mktRes.isValid).toBe(true);
        expect(mktRes.quantizedQuantity).toBe(200000);
        expect(mktRes.wasClampedToMax).toBe(true);

        // 2. LIMIT order with $2,500 at $0.005 (raw = 500,000) -> uses maxQty (1,000,000), NOT clamped to marketMaxQty
        const limitRes = TradeValidator.validate(
          {
            symbol: "1000PEPEUSDT",
            orderType: "LIMIT",
            entryPrice: 0.005,
            tradeValueUsdt: 2500,
          },
          dualMaxRules
        );
        expect(limitRes.isValid).toBe(true);
        expect(limitRes.quantizedQuantity).toBe(500000);
        expect(limitRes.wasClampedToMax).toBe(false);

        // 3. MARKET order when marketMaxQty is undefined (absent) -> does NOT fall back to maxQty
        const onlyLimitMaxRules: SymbolTradingRules = {
          ...mock1000PepeRules,
          maxQty: 200000,
          marketMaxQty: undefined,
        };
        const unconstrainedMktRes = TradeValidator.validate(
          {
            symbol: "1000PEPEUSDT",
            orderType: "MARKET",
            entryPrice: 0.005,
            tradeValueUsdt: 2500,
          },
          onlyLimitMaxRules
        );
        expect(unconstrainedMktRes.isValid).toBe(true);
        expect(unconstrainedMktRes.quantizedQuantity).toBe(500000);
        expect(unconstrainedMktRes.wasClampedToMax).toBe(false);
      });

      it("safely accepts unconstrained orders when maxQty metadata is omitted/undefined", () => {
        const unconstrainedRules = { ...mock1000PepeRules, maxQty: undefined };
        const res = TradeValidator.validate(
          {
            symbol: "1000PEPEUSDT",
            entryPrice: 0.004962,
            quantity: 2000, // notional = 2000 * 0.004962 = ~9.92 USDT >= minNotional 5
            isApprovedQuantity: true,
          },
          unconstrainedRules
        );

        expect(res.isValid).toBe(true);
        expect(res.quantizedQuantity).toBe(2000);
        expect(res.wasClampedToMax).toBe(false);
      });
    });
  });
});

