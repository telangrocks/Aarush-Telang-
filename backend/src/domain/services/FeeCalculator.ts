import { Money } from '../value-objects/Money';
import { Price } from '../value-objects/Price';
import { Quantity } from '../value-objects/Quantity';
import { Percentage } from '../value-objects/Percentage';

export class FeeCalculator {
  public static calculateFee(
    price: Price,
    quantity: Quantity,
    feeRate: Percentage,
    quoteCurrency: string = 'USDT'
  ): Money {
    const notional = price.value.multipliedBy(quantity.value);
    const feeAmount = notional.multipliedBy(feeRate.toFraction());
    const res = Money.create(feeAmount, quoteCurrency);
    return res.isSuccess ? res.value : (Money.create(0, quoteCurrency) as any).value;
  }
}
