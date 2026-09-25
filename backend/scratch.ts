import BigNumber from 'bignumber.js';

export class PriceNormalizer {
  public static normalizeTradePrices(args: any): any {
    const { entryPrice, theoreticalSL, theoreticalTP, tickSize, minAllowedPrice, side } = args;
    const tickSizeBN = new BigNumber(tickSize);
    const entryBN = new BigNumber(entryPrice);
    const minAllowedBN = new BigNumber(minAllowedPrice);

    let quantizedStopLossBN: BigNumber;
    let quantizedTakeProfitBN: BigNumber;

    if (side === 'BUY') {
      const maxAllowedSL = entryBN.minus(tickSizeBN);
      let boundedSL = BigNumber.min(new BigNumber(theoreticalSL), maxAllowedSL);
      boundedSL = BigNumber.max(minAllowedBN, boundedSL);

      const minAllowedTP = entryBN.plus(tickSizeBN);
      const boundedTP = BigNumber.max(minAllowedTP, new BigNumber(theoreticalTP));

      const stepsSL = boundedSL.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_FLOOR);
      quantizedStopLossBN = stepsSL.multipliedBy(tickSizeBN);
      if (quantizedStopLossBN.gte(entryBN)) quantizedStopLossBN = entryBN.minus(tickSizeBN);
      if (quantizedStopLossBN.lt(minAllowedBN)) quantizedStopLossBN = minAllowedBN;

      const stepsTP = boundedTP.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_CEIL);
      quantizedTakeProfitBN = stepsTP.multipliedBy(tickSizeBN);
      if (quantizedTakeProfitBN.lte(entryBN)) quantizedTakeProfitBN = entryBN.plus(tickSizeBN);
    } else {
      const minAllowedSL = entryBN.plus(tickSizeBN);
      const boundedSL = BigNumber.max(minAllowedSL, new BigNumber(theoreticalSL));

      const maxAllowedTP = entryBN.minus(tickSizeBN);
      let boundedTP = BigNumber.min(new BigNumber(theoreticalTP), maxAllowedTP);
      boundedTP = BigNumber.max(minAllowedBN, boundedTP);

      const stepsSL = boundedSL.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_CEIL);
      quantizedStopLossBN = stepsSL.multipliedBy(tickSizeBN);
      if (quantizedStopLossBN.lte(entryBN)) quantizedStopLossBN = entryBN.plus(tickSizeBN);

      const stepsTP = boundedTP.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_FLOOR);
      quantizedTakeProfitBN = stepsTP.multipliedBy(tickSizeBN);
      if (quantizedTakeProfitBN.gte(entryBN)) quantizedTakeProfitBN = entryBN.minus(tickSizeBN);
      if (quantizedTakeProfitBN.lt(minAllowedBN)) quantizedTakeProfitBN = minAllowedBN;
    }

    const decimals = Math.max(0, tickSizeBN.decimalPlaces() ?? 2);
    return {
      entryPrice,
      stopLoss: parseFloat(quantizedStopLossBN.toFixed(decimals)),
      takeProfit: parseFloat(quantizedTakeProfitBN.toFixed(decimals))
    };
  }
}

const normResult = PriceNormalizer.normalizeTradePrices({
  entryPrice: 4.5,
  theoreticalSL: 0,
  theoreticalTP: 4.702,
  tickSize: 0.01,
  minAllowedPrice: 0.01,
  side: 'BUY'
});

console.log(normResult);
