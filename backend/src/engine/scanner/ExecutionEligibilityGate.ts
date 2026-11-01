import BigNumber from 'bignumber.js';

export interface ExecutionEligibilityParams {
  readonly tradeAmountUsdt: number;
  readonly currentPrice: number;
  readonly qtyStep: number;
  readonly minOrderQty: number;
  readonly minNotional: number;
  readonly maxOrderQty?: number;
}

export interface ExecutionEligibilityResult {
  readonly isExecutable: boolean;
  readonly rawQty: number;
  readonly quantizedQty: number;
  readonly postRoundingNotional: number;
  readonly minNotional: number;
  readonly minOrderQty: number;
  readonly qtyStep: number;
  readonly maxOrderQty?: number;
  readonly wasClampedToMax?: boolean;
  readonly rejectionReason?: string;
}

/**
 * ExecutionEligibilityGate: Reusable evaluation component for determining whether a ticker
 * can be legitimately executed given a user's USDT capital allocation and exchange constraints.
 *
 * Quantization semantics strictly match TradeValidator and final order execution:
 *   rawQty = tradeAmountUsdt / currentPrice
 *   steps = floor(rawQty / qtyStep)
 *   quantizedQty = steps * qtyStep
 *   postRoundingNotional = quantizedQty * currentPrice
 *
 * Executable only when:
 *   tradeAmountUsdt >= minNotional
 *   AND quantizedQty >= minOrderQty
 *   AND postRoundingNotional >= minNotional
 */
export class ExecutionEligibilityGate {
  public static evaluate(params: ExecutionEligibilityParams): ExecutionEligibilityResult {
    const tradeAmount = params.tradeAmountUsdt;
    const price = params.currentPrice;

    if (!tradeAmount || tradeAmount <= 0 || isNaN(tradeAmount)) {
      return {
        isExecutable: false,
        rawQty: 0,
        quantizedQty: 0,
        postRoundingNotional: 0,
        minNotional: params.minNotional || 5,
        minOrderQty: params.minOrderQty || 0,
        qtyStep: params.qtyStep || 0,
        rejectionReason: 'Invalid trade amount (must be positive)',
      };
    }

    if (!price || price <= 0 || isNaN(price)) {
      return {
        isExecutable: false,
        rawQty: 0,
        quantizedQty: 0,
        postRoundingNotional: 0,
        minNotional: params.minNotional || 5,
        minOrderQty: params.minOrderQty || 0,
        qtyStep: params.qtyStep || 0,
        rejectionReason: 'Invalid market price (must be positive)',
      };
    }

    if (!params.qtyStep || !Number.isFinite(params.qtyStep) || params.qtyStep <= 0) {
      return {
        isExecutable: false,
        rawQty: 0,
        quantizedQty: 0,
        postRoundingNotional: 0,
        minNotional: params.minNotional || 5,
        minOrderQty: params.minOrderQty || 0,
        qtyStep: params.qtyStep || 0,
        rejectionReason: 'Invalid exchange quantity step size (must be positive and finite)',
      };
    }

    if (params.maxOrderQty === undefined || params.maxOrderQty === null || !Number.isFinite(params.maxOrderQty) || params.maxOrderQty <= 0) {
      return {
        isExecutable: false,
        rawQty: 0,
        quantizedQty: 0,
        postRoundingNotional: 0,
        minNotional: params.minNotional || 5,
        minOrderQty: params.minOrderQty || 0,
        qtyStep: params.qtyStep || 0,
        maxOrderQty: params.maxOrderQty,
        rejectionReason: 'Invalid exchange maximum order quantity (must be positive and finite)',
      };
    }

    const minNotional = params.minNotional > 0 ? params.minNotional : 5.0;
    const minOrderQty = params.minOrderQty > 0 ? params.minOrderQty : 0.00001;
    const qtyStep = params.qtyStep;

    const tradeAmountBN = new BigNumber(tradeAmount);
    const priceBN = new BigNumber(price);
    const minNotionalBN = new BigNumber(minNotional);
    const minOrderQtyBN = new BigNumber(minOrderQty);
    const stepSizeBN = new BigNumber(qtyStep);

    // Initial check: tradeAmountUsdt >= minNotional
    if (tradeAmountBN.isLessThan(minNotionalBN)) {
      return {
        isExecutable: false,
        rawQty: tradeAmountBN.dividedBy(priceBN).toNumber(),
        quantizedQty: 0,
        postRoundingNotional: 0,
        minNotional,
        minOrderQty,
        qtyStep,
        rejectionReason: `Trade amount ($${tradeAmount.toFixed(2)} USDT) is below exchange minNotional ($${minNotional.toFixed(2)} USDT)`,
      };
    }

    // rawQty = tradeAmountUsdt / currentPrice
    const rawQtyBN = tradeAmountBN.dividedBy(priceBN);

    // Apply exchange maximum quantity constraint before step-size quantization
    let effectiveRawQtyBN = rawQtyBN;
    let wasClampedToMax = false;
    const maxOrderQty = params.maxOrderQty;
    const maxOrderQtyBN = new BigNumber(maxOrderQty);
    if (rawQtyBN.isGreaterThan(maxOrderQtyBN)) {
      effectiveRawQtyBN = maxOrderQtyBN;
      wasClampedToMax = true;
    }

    // steps = floor(effectiveRawQty / qtyStep)
    const stepsBN = effectiveRawQtyBN.dividedBy(stepSizeBN).integerValue(BigNumber.ROUND_FLOOR);

    // quantizedQty = steps * qtyStep
    const quantizedQtyBN = stepsBN.multipliedBy(stepSizeBN);

    // postRoundingNotional = quantizedQty * currentPrice
    const postRoundingNotionalBN = quantizedQtyBN.multipliedBy(priceBN);

    const rawQty = rawQtyBN.toNumber();
    const quantizedQty = quantizedQtyBN.toNumber();
    const postRoundingNotional = postRoundingNotionalBN.toNumber();

    // Check quantizedQty >= minOrderQty
    if (quantizedQtyBN.isLessThan(minOrderQtyBN)) {
      const minCapitalRequired = minOrderQtyBN.multipliedBy(priceBN).toNumber();
      return {
        isExecutable: false,
        rawQty,
        quantizedQty,
        postRoundingNotional,
        minNotional,
        minOrderQty,
        qtyStep,
        maxOrderQty,
        wasClampedToMax,
        rejectionReason: `Quantized qty (${quantizedQty}) < minOrderQty (${minOrderQty}) (requires min ~$${minCapitalRequired.toFixed(2)} USDT at price $${price.toFixed(4)})`,
      };
    }

    // Check postRoundingNotional >= minNotional
    if (postRoundingNotionalBN.isLessThan(minNotionalBN)) {
      const postRoundingDisplay = postRoundingNotional.toFixed(2) === minNotional.toFixed(2) && postRoundingNotional < minNotional
        ? postRoundingNotional.toFixed(4)
        : postRoundingNotional.toFixed(2);
      return {
        isExecutable: false,
        rawQty,
        quantizedQty,
        postRoundingNotional,
        minNotional,
        minOrderQty,
        qtyStep,
        maxOrderQty,
        wasClampedToMax,
        rejectionReason: `Post-rounding notional ($${postRoundingDisplay} USDT) < minNotional ($${minNotional.toFixed(2)} USDT)`,
      };
    }

    return {
      isExecutable: true,
      rawQty,
      quantizedQty,
      postRoundingNotional,
      minNotional,
      minOrderQty,
      qtyStep,
      maxOrderQty,
      wasClampedToMax,
    };
  }
}
