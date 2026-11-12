import BigNumber from "bignumber.js";
import { SymbolTradingRules, ValidationErrorReason } from "../exchanges/types";

export interface TradeValidationParams {
  symbol: string;
  entryPrice: number;
  side?: 'BUY' | 'SELL' | 'buy' | 'sell';
  orderType?: 'LIMIT' | 'MARKET' | 'limit' | 'market';
  entryIntent?: 'WAIT_FOR_PRICE' | 'IMMEDIATE' | 'TRIGGER';
  markPrice?: number;
  currentMarketPrice?: number;
  tradeValueUsdt?: number;
  quantity?: number;
  isApprovedQuantity?: boolean;
  maxBudgetUsdt?: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface TradeValidationResult {
  isValid: boolean;
  errorCode?: ValidationErrorReason;
  errorMessage?: string;
  quantizedQuantity?: number;
  postRoundingNotional?: number;
  wasClampedToMax?: boolean;
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

    if (rules.maxQty !== undefined && rules.maxQty !== null && (!Number.isFinite(rules.maxQty) || rules.maxQty <= 0)) {
      const res = {
        isValid: false,
        errorCode: ValidationErrorReason.EXCHANGE_METADATA_UNAVAILABLE,
        errorMessage: `Authoritative exchange maximum order quantity (maxQty) for '${rules.symbol}' is invalid (${rules.maxQty}). Execution cannot safely proceed.`,
        metrics: { durationMs: performance.now() - startTime, stepReached: 1 },
      };
      console.log('[DIAGNOSTIC] Exit TradeValidator.validate() (maxQty metadata failure):', JSON.stringify(res));
      return res;
    }

    if (rules.marketMaxQty !== undefined && rules.marketMaxQty !== null && (!Number.isFinite(rules.marketMaxQty) || rules.marketMaxQty <= 0)) {
      const res = {
        isValid: false,
        errorCode: ValidationErrorReason.EXCHANGE_METADATA_UNAVAILABLE,
        errorMessage: `Authoritative exchange market-order maximum quantity (marketMaxQty) for '${rules.symbol}' is invalid (${rules.marketMaxQty}). Execution cannot safely proceed.`,
        metrics: { durationMs: performance.now() - startTime, stepReached: 1 },
      };
      console.log('[DIAGNOSTIC] Exit TradeValidator.validate() (marketMaxQty metadata failure):', JSON.stringify(res));
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
    const minPriceBN = new BigNumber(rules.minPrice ?? 0);
    const maxPriceBN = new BigNumber(rules.maxPrice ?? 0);
    const tickSizeBN = new BigNumber(rules.tickSize ?? 0);

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

    // 3.5 Dynamic Price Band Validation (Bybit Dynamic Mark Price Bands)
    const refPrice = params.markPrice || params.currentMarketPrice || rules.markPrice;
    if (refPrice && refPrice > 0) {
      const refPriceBN = new BigNumber(refPrice);
      const ratioX = rules.priceLimitRatioX ? new BigNumber(rules.priceLimitRatioX) : new BigNumber(0.10);
      const ratioY = rules.priceLimitRatioY ? new BigNumber(rules.priceLimitRatioY) : new BigNumber(0.10);

      const isBuy = !params.side || params.side.toUpperCase() === 'BUY';
      const isLimitOrWait = !params.orderType || params.orderType.toUpperCase() === 'LIMIT' || params.entryIntent === 'WAIT_FOR_PRICE';

      if (isLimitOrWait) {
        if (isBuy && ratioX.isGreaterThan(0)) {
          const maxBandPrice = refPriceBN.multipliedBy(new BigNumber(1).plus(ratioX));
          if (entryPriceBN.isGreaterThan(maxBandPrice)) {
            return {
              isValid: false,
              errorCode: ValidationErrorReason.PRICE_ABOVE_MAXIMUM,
              errorMessage: `Limit Buy price ($${entryPriceBN.toFixed()}) exceeds exchange dynamic price band ($${maxBandPrice.toFixed()}). Current mark price is $${refPriceBN.toFixed()}.`,
              metrics: { durationMs: performance.now() - startTime, stepReached: 3.5 },
            };
          }
        } else if (!isBuy && ratioY.isGreaterThan(0)) {
          const minBandPrice = refPriceBN.multipliedBy(new BigNumber(1).minus(ratioY));
          if (entryPriceBN.isLessThan(minBandPrice)) {
            return {
              isValid: false,
              errorCode: ValidationErrorReason.PRICE_BELOW_MINIMUM,
              errorMessage: `Limit Sell price ($${entryPriceBN.toFixed()}) is below exchange dynamic price band ($${minBandPrice.toFixed()}). Current mark price is $${refPriceBN.toFixed()}.`,
              metrics: { durationMs: performance.now() - startTime, stepReached: 3.5 },
            };
          }
        }
      }
    }

    // 4. Raw Quantity Calculation
    let rawQtyBN: BigNumber;
    const isApprovedQuantityValidation = params.isApprovedQuantity === true;
    if (params.quantity !== undefined && params.quantity !== null && params.quantity > 0) {
      rawQtyBN = new BigNumber(params.quantity!);
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

    // 4.5. Maximum Quantity Constraint Enforcement
    const isMarketOrder = params.orderType?.toUpperCase() === 'MARKET';
    const applicableMax = isMarketOrder ? rules.marketMaxQty : rules.maxQty;

    const hasMaxQtyConstraint = applicableMax !== undefined && applicableMax !== null;
    const maxQtyBN = hasMaxQtyConstraint ? new BigNumber(applicableMax) : null;
    let clampedQtyBN = rawQtyBN;
    let wasClampedToMax = false;

    if (maxQtyBN) {
      if (isApprovedQuantityValidation) {
        // If verifying an already approved quantity, DO NOT silently modify it!
        // If the approved quantity exceeds maxQty, fail closed and require fresh confirmation.
        if (rawQtyBN.isGreaterThan(maxQtyBN)) {
          return {
            isValid: false,
            errorCode: ValidationErrorReason.MAX_QTY_FAILED,
            errorMessage: `Approved order quantity (${rawQtyBN.toFixed()}) exceeds exchange maximum order quantity (${maxQtyBN.toFixed()}). Fresh confirmation is required.`,
            quantizedQuantity: rawQtyBN.toNumber(),
            postRoundingNotional: rawQtyBN.multipliedBy(entryPriceBN).toNumber(),
            wasClampedToMax: true,
            metrics: { durationMs: performance.now() - startTime, stepReached: 4.5 },
          };
        }
      } else {
        // During initial sizing (budget -> quantity), clamp raw quantity to exchange maximum limit before step-size quantization
        if (rawQtyBN.isGreaterThan(maxQtyBN)) {
          clampedQtyBN = maxQtyBN;
          wasClampedToMax = true;
        }
      }
    }

    // 5. Step Size Quantization (Floor rounding to stepSize)
    const stepSizeBN = new BigNumber(rules.stepSize ?? 0);
    let roundedQtyBN: BigNumber = clampedQtyBN;
    if (stepSizeBN.isGreaterThan(0)) {
      const steps = clampedQtyBN.dividedBy(stepSizeBN).integerValue(BigNumber.ROUND_FLOOR);
      roundedQtyBN = steps.multipliedBy(stepSizeBN);
    }

    if (isApprovedQuantityValidation) {
      // If verifying an already approved quantity, ensure it is aligned with step size and not modified
      if (!roundedQtyBN.isEqualTo(rawQtyBN)) {
        return {
          isValid: false,
          errorCode: ValidationErrorReason.INVALID_STEP_SIZE,
          errorMessage: `Approved order quantity (${rawQtyBN.toFixed()}) is not aligned with exchange step size (${stepSizeBN.toFixed()}). Fresh confirmation is required.`,
          quantizedQuantity: roundedQtyBN.toNumber(),
          postRoundingNotional: roundedQtyBN.multipliedBy(entryPriceBN).toNumber(),
          metrics: { durationMs: performance.now() - startTime, stepReached: 5 },
        };
      }
    }

    // 6. Quantity Filter (Independent validation of final quantity against all exchange limits)
    const minQtyBN = new BigNumber(rules.minQty ?? 0);

    if (minQtyBN.isGreaterThan(0) && roundedQtyBN.isLessThan(minQtyBN)) {
      return {
        isValid: false,
        errorCode: ValidationErrorReason.MIN_QTY_FAILED,
        errorMessage: `Order quantity (${roundedQtyBN.toFixed()}) is below exchange minimum order quantity (${minQtyBN.toFixed()}).`,
        quantizedQuantity: roundedQtyBN.toNumber(),
        metrics: { durationMs: performance.now() - startTime, stepReached: 6 },
      };
    }

    if (maxQtyBN && maxQtyBN.isGreaterThan(0) && roundedQtyBN.isGreaterThan(maxQtyBN)) {
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
    const minNotionalBN = new BigNumber(rules.minNotional ?? 0);

    if (minNotionalBN.isGreaterThan(0) && postRoundingNotionalBN.isLessThan(minNotionalBN)) {
      return {
        isValid: false,
        errorCode: ValidationErrorReason.MIN_NOTIONAL_FAILED,
        errorMessage: `Order value ($${postRoundingNotionalBN.toFixed(4)} USDT) is below exchange minimum notional requirement of $${minNotionalBN.toFixed(2)} USDT.`,
        quantizedQuantity: roundedQtyBN.toNumber(),
        postRoundingNotional: postRoundingNotionalBN.toNumber(),
        metrics: { durationMs: performance.now() - startTime, stepReached: 7 },
      };
    }

    if (params.maxBudgetUsdt !== undefined && params.maxBudgetUsdt > 0) {
      const maxBudgetBN = new BigNumber(params.maxBudgetUsdt);
      if (postRoundingNotionalBN.isGreaterThan(maxBudgetBN)) {
        return {
          isValid: false,
          errorCode: ValidationErrorReason.BUDGET_EXCEEDED,
          errorMessage: `Order value ($${postRoundingNotionalBN.toFixed(4)} USDT) exceeds approved budget ($${maxBudgetBN.toFixed(4)} USDT).`,
          quantizedQuantity: roundedQtyBN.toNumber(),
          postRoundingNotional: postRoundingNotionalBN.toNumber(),
          metrics: { durationMs: performance.now() - startTime, stepReached: 7 },
        };
      }
    }

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
      wasClampedToMax,
      metrics: { durationMs: performance.now() - startTime, stepReached: 9 },
    };
    console.log('[DIAGNOSTIC] Exit TradeValidator.validate() (Success):', JSON.stringify(finalResult));
    return finalResult;
  }
}
