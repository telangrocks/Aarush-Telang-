import BigNumber from 'bignumber.js';
import { Price } from '../value-objects/Price';
import { Quantity } from '../value-objects/Quantity';
import { Money } from '../value-objects/Money';
import { Percentage } from '../value-objects/Percentage';

export class PnLCalculator {
  public static calculateUnrealizedPnL(
    side: 'long' | 'short',
    entryPrice: Price,
    currentPrice: Price,
    quantity: Quantity,
    quoteCurrency: string = 'USDT'
  ): Money {
    let pnlValue: BigNumber;
    if (side === 'long') {
      pnlValue = currentPrice.value.minus(entryPrice.value).multipliedBy(quantity.value);
    } else {
      pnlValue = entryPrice.value.minus(currentPrice.value).multipliedBy(quantity.value);
    }
    const moneyRes = Money.create(pnlValue, quoteCurrency);
    return moneyRes.isSuccess ? moneyRes.value : (Money.create(0, quoteCurrency) as any).value;
  }

  public static calculateReturnOnInvestment(
    entryPrice: Price,
    currentPrice: Price,
    side: 'long' | 'short'
  ): Percentage {
    if (entryPrice.value.isEqualTo(0)) {
      return (Percentage.create(0) as any).value;
    }
    let roi: BigNumber;
    if (side === 'long') {
      roi = currentPrice.value.minus(entryPrice.value).dividedBy(entryPrice.value).multipliedBy(100);
    } else {
      roi = entryPrice.value.minus(currentPrice.value).dividedBy(entryPrice.value).multipliedBy(100);
    }
    const pctRes = Percentage.create(roi);
    return pctRes.isSuccess ? pctRes.value : (Percentage.create(0) as any).value;
  }
}
