import BigNumber from 'bignumber.js';
import { Price } from '../value-objects/Price';
import { Money } from '../value-objects/Money';
import { Quantity } from '../value-objects/Quantity';
import { Percentage } from '../value-objects/Percentage';

export class PositionSizer {
  public static calculatePositionSize(
    accountBalance: Money,
    riskPercentage: Percentage,
    entryPrice: Price,
    stopLossPrice: Price
  ): Quantity {
    if (entryPrice.equals(stopLossPrice) || entryPrice.value.isEqualTo(0)) {
      return (Quantity.create(0) as any).value;
    }

    const maxRiskAmount = accountBalance.amount.multipliedBy(riskPercentage.toFraction());
    const priceRisk = entryPrice.value.minus(stopLossPrice.value).abs();

    if (priceRisk.isEqualTo(0)) {
      return (Quantity.create(0) as any).value;
    }

    const rawQty = maxRiskAmount.dividedBy(priceRisk);
    const res = Quantity.create(rawQty);
    return res.isSuccess ? res.value : (Quantity.create(0) as any).value;
  }
}
