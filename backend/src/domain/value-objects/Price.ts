import BigNumber from 'bignumber.js';
import { Result, ok, fail, createDomainError } from '../types/Result';

export class Price {
  private constructor(readonly value: BigNumber) {}

  public static create(input: number | string | BigNumber): Result<Price> {
    const bn = new BigNumber(input);
    if (bn.isNaN() || !bn.isFinite() || bn.isLessThan(0)) {
      return fail(createDomainError('INVALID_PRICE', `Invalid price value: ${input}. Price must be a non-negative number.`));
    }
    return ok(new Price(bn));
  }

  public quantizeToTickSize(tickSize: Price): Price {
    if (tickSize.value.isLessThanOrEqualTo(0)) return this;
    const steps = this.value.dividedBy(tickSize.value).integerValue(BigNumber.ROUND_FLOOR);
    return new Price(steps.multipliedBy(tickSize.value));
  }

  public equals(other: Price): boolean {
    return this.value.isEqualTo(other.value);
  }

  public isGreaterThan(other: Price): boolean {
    return this.value.isGreaterThan(other.value);
  }

  public isLessThan(other: Price): boolean {
    return this.value.isLessThan(other.value);
  }

  public toNumber(): number {
    return this.value.toNumber();
  }

  public toString(): string {
    return this.value.toFixed();
  }
}
