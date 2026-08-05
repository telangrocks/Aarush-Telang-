import BigNumber from 'bignumber.js';
import { Result, ok, fail, createDomainError } from '../types/Result';

export class Quantity {
  private constructor(readonly value: BigNumber) {}

  public static create(input: number | string | BigNumber): Result<Quantity> {
    const bn = new BigNumber(input);
    if (bn.isNaN() || !bn.isFinite() || bn.isLessThan(0)) {
      return fail(createDomainError('INVALID_QUANTITY', `Invalid quantity value: ${input}. Quantity must be a non-negative number.`));
    }
    return ok(new Quantity(bn));
  }

  public quantizeToStepSize(stepSize: Quantity): Quantity {
    if (stepSize.value.isLessThanOrEqualTo(0)) return this;
    const steps = this.value.dividedBy(stepSize.value).integerValue(BigNumber.ROUND_FLOOR);
    return new Quantity(steps.multipliedBy(stepSize.value));
  }

  public equals(other: Quantity): boolean {
    return this.value.isEqualTo(other.value);
  }

  public isGreaterThan(other: Quantity): boolean {
    return this.value.isGreaterThan(other.value);
  }

  public isLessThan(other: Quantity): boolean {
    return this.value.isLessThan(other.value);
  }

  public toNumber(): number {
    return this.value.toNumber();
  }

  public toString(): string {
    return this.value.toFixed();
  }
}
