import BigNumber from 'bignumber.js';
import { Result, ok, fail, createDomainError } from '../types/Result';

export class Percentage {
  private constructor(readonly value: BigNumber) {}

  public static create(percentageInput: number | string | BigNumber): Result<Percentage> {
    const bn = new BigNumber(percentageInput);
    if (bn.isNaN() || !bn.isFinite()) {
      return fail(createDomainError('INVALID_PERCENTAGE', `Invalid percentage value: ${percentageInput}.`));
    }
    return ok(new Percentage(bn));
  }

  public toFraction(): BigNumber {
    return this.value.dividedBy(100);
  }

  public toNumber(): number {
    return this.value.toNumber();
  }

  public toString(): string {
    return `${this.value.toFixed(2)}%`;
  }
}
