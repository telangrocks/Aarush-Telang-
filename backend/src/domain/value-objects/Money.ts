import BigNumber from 'bignumber.js';
import { Result, ok, fail, createDomainError } from '../types/Result';

export class Money {
  private constructor(
    readonly amount: BigNumber,
    readonly currency: string
  ) {}

  public static create(amountInput: number | string | BigNumber, currency: string = 'USDT'): Result<Money> {
    const bn = new BigNumber(amountInput);
    if (bn.isNaN() || !bn.isFinite()) {
      return fail(createDomainError('INVALID_MONEY', `Invalid money amount: ${amountInput}.`));
    }
    if (!currency || typeof currency !== 'string' || currency.trim() === '') {
      return fail(createDomainError('INVALID_MONEY', 'Currency must be a non-empty string.'));
    }
    return ok(new Money(bn, currency.trim().toUpperCase()));
  }

  public equals(other: Money): boolean {
    return this.amount.isEqualTo(other.amount) && this.currency === other.currency;
  }

  public toNumber(): number {
    return this.amount.toNumber();
  }

  public toString(): string {
    return `${this.amount.toFixed(2)} ${this.currency}`;
  }
}
