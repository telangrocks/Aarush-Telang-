import BigNumber from 'bignumber.js';

export interface PriceNormalizerArgs {
  entryPrice: number;
  theoreticalSL: number;
  theoreticalTP: number;
  tickSize: number;
  minAllowedPrice: number;
  side: 'BUY' | 'SELL';
}

export interface NormalizedPrices {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}

export class PriceNormalizer {
  /**
   * Quantizes a limit order entry price to the nearest exchange-valid tick.
   * BUY Limits use FLOOR to avoid paying more than authorized.
   * SELL Limits use CEIL to avoid selling for less than authorized.
   */
  public static normalizeLimitPrice(price: number, tickSize: number, side: 'BUY' | 'SELL'): number {
    if (!tickSize || tickSize <= 0) return price;
    const tickSizeBN = new BigNumber(tickSize);
    const priceBN = new BigNumber(price);
    
    // Limits represent strict mathematical bounds:
    // BUY -> FLOOR (Do not pay more than intended)
    // SELL -> CEILING (Do not accept less than intended)
    const roundMode = side === 'BUY' ? BigNumber.ROUND_FLOOR : BigNumber.ROUND_CEIL;
    
    const steps = priceBN.dividedBy(tickSizeBN).integerValue(roundMode);
    const decimals = Math.max(0, tickSizeBN.decimalPlaces() ?? 2);
    return parseFloat(steps.multipliedBy(tickSizeBN).toFixed(decimals));
  }

  /**
   * Applies Bybit tickSize quantization using direction-aware rounding semantics.
   * Ensures risk boundaries are preserved (BUY SL floors, BUY TP ceils).
   */
  public static normalizeTradePrices(args: PriceNormalizerArgs): NormalizedPrices {
    const { entryPrice, theoreticalSL, theoreticalTP, tickSize, minAllowedPrice, side } = args;
    
    const tickSizeBN = new BigNumber(tickSize);
    const entryBN = new BigNumber(entryPrice);
    const minAllowedBN = new BigNumber(minAllowedPrice);

    let quantizedStopLossBN: BigNumber;
    let quantizedTakeProfitBN: BigNumber;

    if (side === 'BUY') {
      // Invariant: SL must be strictly below Entry and >= minAllowedPrice
      const maxAllowedSL = entryBN.minus(tickSizeBN);
      let boundedSL = BigNumber.min(new BigNumber(theoreticalSL), maxAllowedSL);
      boundedSL = BigNumber.max(minAllowedBN, boundedSL);

      const minAllowedTP = entryBN.plus(tickSizeBN);
      const boundedTP = BigNumber.max(minAllowedTP, new BigNumber(theoreticalTP));

      // Quantization: BUY SL floors (to stay below Entry), BUY TP ceils
      const stepsSL = boundedSL.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_FLOOR);
      quantizedStopLossBN = stepsSL.multipliedBy(tickSizeBN);
      if (quantizedStopLossBN.gte(entryBN)) {
        quantizedStopLossBN = entryBN.minus(tickSizeBN);
      }
      if (quantizedStopLossBN.lt(minAllowedBN)) {
        quantizedStopLossBN = minAllowedBN;
      }

      const stepsTP = boundedTP.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_CEIL);
      quantizedTakeProfitBN = stepsTP.multipliedBy(tickSizeBN);
      if (quantizedTakeProfitBN.lte(entryBN)) {
        quantizedTakeProfitBN = entryBN.plus(tickSizeBN);
      }
    } else {
      // Invariant: SL must be strictly above Entry, TP strictly below Entry and >= minAllowedPrice
      const minAllowedSL = entryBN.plus(tickSizeBN);
      const boundedSL = BigNumber.max(minAllowedSL, new BigNumber(theoreticalSL));

      const maxAllowedTP = entryBN.minus(tickSizeBN);
      let boundedTP = BigNumber.min(new BigNumber(theoreticalTP), maxAllowedTP);
      boundedTP = BigNumber.max(minAllowedBN, boundedTP);

      // Quantization: SELL SL ceils (to stay above Entry), SELL TP floors
      const stepsSL = boundedSL.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_CEIL);
      quantizedStopLossBN = stepsSL.multipliedBy(tickSizeBN);
      if (quantizedStopLossBN.lte(entryBN)) {
        quantizedStopLossBN = entryBN.plus(tickSizeBN);
      }

      const stepsTP = boundedTP.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_FLOOR);
      quantizedTakeProfitBN = stepsTP.multipliedBy(tickSizeBN);
      if (quantizedTakeProfitBN.gte(entryBN)) {
        quantizedTakeProfitBN = entryBN.minus(tickSizeBN);
      }
      if (quantizedTakeProfitBN.lt(minAllowedBN)) {
        quantizedTakeProfitBN = minAllowedBN;
      }
    }

    const decimals = Math.max(0, tickSizeBN.decimalPlaces() ?? 2);
    const finalStopLoss = parseFloat(quantizedStopLossBN.toFixed(decimals));
    const finalTakeProfit = parseFloat(quantizedTakeProfitBN.toFixed(decimals));

    return {
      entryPrice,
      stopLoss: finalStopLoss,
      takeProfit: finalTakeProfit
    };
  }
}
