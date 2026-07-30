import BigNumber from "bignumber.js";
import { SymbolTradingRules, ValidationErrorReason } from "../exchanges/types";

export interface TradeValidationParams {
  symbol: string;
  entryPrice: number;
  tradeValueUsdt?: number;
  quantity?: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface TradeValidationResult {
  isValid: boolean;
  errorCode?: ValidationErrorReason;
  errorMessage?: string;
  quantizedQuantity?: number;
  postRoundingNotional?: number;
  metrics?: {
    durationMs: number;
    stepReached: number;
  };
}

export class TradeValidator {
  /**
   * Evaluates trade parameters against verified exchange symbol trading rules using
   * high-precision arbitrary decimal arithmetic (BigNumber.js).
   */
  public static validate(
    params: TradeValidationParams,
    rules: SymbolTradingRules | null
  ): TradeValidationResult {
    const startTime = performance.now();
    console.log('[DIAGNOSTIC] Entry into TradeValidator.validate():', JSON.stringify({ params, rulesSummary: rules ? { symbol: rules.symbol, minNotional: rules.minNotional, minQty: rules.minQty, stepSize: rules.stepSize } : null }));

    // 1. Metadata Check
    if (!rules || !rules.symbol) {
      const res = {
        isValid: false,
        errorCode: ValidationErrorReason.EXCHANGE_METADATA_UNAVAILABLE,
        errorMessage: `Exchange trading rules for '${params.symbol}' could not be loaded from exchange. Please try again.`,
        metrics: { durationMs: performance.now() - startTime, stepReached: 1 },
      };
      console.log('[DIAGNOSTIC] Exit TradeValidator.validate() (Metadata failure):', JSON.stringify(res));
      return res;
    }

    // 2. Input Parameter Validation
    const entryPriceBN = new BigNumber(params.entryPrice);
    if (entryPriceBN.isNaN() || !entryPriceBN.isFinite() || entryPriceBN.isLessThanOrEqualTo(0)) {
      return {
        isValid: false,
        errorCode: ValidationErrorReason.INVALID_INPUT_PARAMETERS,
        errorMessage: "Entry price must be a valid positive number.",
        metrics: { durationMs: performance.now() - startTime, stepReached: 2 },
      };
    }

    // 3. Price & Tick Size Filter
    const minPriceBN = new BigNumber(rules.minPrice);
    const maxPriceBN = new BigNumber(rules.maxPrice);
    const tickSizeBN = new BigNumber(rules.tickSize);

    if (minPriceBN.isGreaterThan(0) && entryPriceBN.isLessThan(minPriceBN)) {
      return {
        isValid: false,
        errorCode: ValidationErrorReason.PRICE_BELOW_MINIMUM,
        errorMessage: `Entry price ($${entryPriceBN.toFixed()}) is below exchange minimum price ($${minPriceBN.toFixed()}).`,
        metrics: { durationMs: performance.now() - startTime, stepReached: 3 },
      };
    }

    if (maxPriceBN.isGreaterThan(0) && entryPriceBN.isGreaterThan(maxPriceBN)) {
      return {
        isValid: false,
        errorCode: ValidationErrorReason.PRICE_ABOVE_MAXIMUM,
        errorMessage: `Entry price ($${entryPriceBN.toFixed()}) exceeds exchange maximum price ($${maxPriceBN.toFixed()}).`,
        metrics: { durationMs: performance.now() - startTime, stepReached: 3 },
      };
    }

    if (tickSizeBN.isGreaterThan(0)) {
      const remainder = entryPriceBN.modulo(tickSizeBN);
      // Epsilon tolerance check for float precision modulo
      if (!remainder.isEqualTo(0) && !remainder.isEqualTo(tickSizeBN)) {
        const threshold = tickSizeBN.multipliedBy(0.0001);
        if (remainder.isGreaterThan(threshold) && tickSizeBN.minus(remainder).isGreaterThan(threshold)) {
          return {
            isValid: false,
            errorCode: ValidationErrorReason.INVALID_TICK_SIZE,
            errorMessage: `Entry price ($${entryPriceBN.toFixed()}) does not align with exchange tick size (${tickSizeBN.toFixed()}).`,
            metrics: { durationMs: performance.now() - startTime, stepReached: 3 },
          };
        }
      }
    }

    // 4. Raw Quantity Calculation
    let rawQtyBN: BigNumber;
    if (params.quantity && params.quantity > 0) {
      rawQtyBN = new BigNumber(params.quantity);
    } else if (params.tradeValueUsdt && params.tradeValueUsdt > 0) {
      rawQtyBN = new BigNumber(params.tradeValueUsdt).dividedBy(entryPriceBN);
    } else {
      return {
        isValid: false,
        errorCode: ValidationErrorReason.INVALID_INPUT_PARAMETERS,
        errorMessage: "Trade quantity or trade amount (USDT) must be provided.",
        metrics: { durationMs: performance.now() - startTime, stepReached: 4 },
      };
    }

    // 5. Step Size Quantization (Floor rounding to stepSize)
    const stepSizeBN = new BigNumber(rules.stepSize);
    let roundedQtyBN: BigNumber = rawQtyBN;
    if (stepSizeBN.isGreaterThan(0)) {
      const steps = rawQtyBN.dividedBy(stepSizeBN).integerValue(BigNumber.ROUND_FLOOR);
      roundedQtyBN = steps.multipliedBy(stepSizeBN);
    }

    // 6. Quantity Filter (Min/Max Qty)
    const minQtyBN = new BigNumber(rules.minQty);
    const maxQtyBN = new BigNumber(rules.maxQty);

    if (roundedQtyBN.isLessThan(minQtyBN)) {
      return {
        isValid: false,
        errorCode: ValidationErrorReason.MIN_QTY_FAILED,
        errorMessage: `Order quantity (${roundedQtyBN.toFixed()}) is below exchange minimum order quantity (${minQtyBN.toFixed()}).`,
        quantizedQuantity: roundedQtyBN.toNumber(),
        metrics: { durationMs: performance.now() - startTime, stepReached: 6 },
      };
    }

    if (maxQtyBN.isGreaterThan(0) && roundedQtyBN.isGreaterThan(maxQtyBN)) {
      return {
        isValid: false,
        errorCode: ValidationErrorReason.MAX_QTY_FAILED,
        errorMessage: `Order quantity (${roundedQtyBN.toFixed()}) exceeds exchange maximum order quantity (${maxQtyBN.toFixed()}).`,
        quantizedQuantity: roundedQtyBN.toNumber(),
        metrics: { durationMs: performance.now() - startTime, stepReached: 6 },
      };
    }

    // 7. Post-Rounding Notional Calculation
    const postRoundingNotionalBN = roundedQtyBN.multipliedBy(entryPriceBN);
    const minNotionalBN = new BigNumber(rules.minNotional);

    if (minNotionalBN.isGreaterThan(0) && postRoundingNotionalBN.isLessThan(minNotionalBN)) {
      return {
        isValid: false,
        errorCode: ValidationErrorReason.MIN_NOTIONAL_FAILED,
        errorMessage: `Order value ($${postRoundingNotionalBN.toFixed(2)} USDT) is below exchange minimum notional requirement of $${minNotionalBN.toFixed(2)} USDT.`,
        quantizedQuantity: roundedQtyBN.toNumber(),
        postRoundingNotional: postRoundingNotionalBN.toNumber(),
        metrics: { durationMs: performance.now() - startTime, stepReached: 7 },
      };
    }

      // 8. Spot-only (Leverage removed)

    if (rules.maxPosition && postRoundingNotionalBN.isGreaterThan(rules.maxPosition)) {
      return {
        isValid: false,
        errorCode: ValidationErrorReason.MAX_POSITION_FAILED,
        errorMessage: `Order value ($${postRoundingNotionalBN.toFixed(2)} USDT) exceeds exchange position limit ($${rules.maxPosition} USDT).`,
        quantizedQuantity: roundedQtyBN.toNumber(),
        postRoundingNotional: postRoundingNotionalBN.toNumber(),
        metrics: { durationMs: performance.now() - startTime, stepReached: 8 },
      };
    }

    const finalResult = {
      isValid: true,
      quantizedQuantity: roundedQtyBN.toNumber(),
      postRoundingNotional: postRoundingNotionalBN.toNumber(),
      metrics: { durationMs: performance.now() - startTime, stepReached: 8 },
    };
    console.log('[DIAGNOSTIC] Exit TradeValidator.validate() (Success):', JSON.stringify(finalResult));
    return finalResult;
  }
}
