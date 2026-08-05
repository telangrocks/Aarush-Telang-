/* eslint-disable @typescript-eslint/ban-types */
import { Result, ok, fail, createDomainError } from '../types/Result';

export class Symbol {
  private static KNOWN_QUOTES = ['USDT', 'BUSD', 'USD', 'USDC', 'BTC', 'ETH'];

  private constructor(
    readonly raw: string,
    readonly baseAsset: string,
    readonly quoteAsset: string,
    readonly formatted: string // e.g. "BTC/USDT"
  ) {}

  public static create(inputSymbol: string, defaultQuote: string = 'USDT'): Result<Symbol> {
    if (!inputSymbol || typeof inputSymbol !== 'string' || inputSymbol.trim() === '') {
      return fail(createDomainError('INVALID_SYMBOL', 'Symbol input must be a non-empty string.'));
    }

    const cleaned = inputSymbol.trim().toUpperCase().replace(/[/\s_-]/g, '');
    let baseAsset = '';
    let quoteAsset = defaultQuote.toUpperCase();

    for (const quote of Symbol.KNOWN_QUOTES) {
      if (cleaned.endsWith(quote) && cleaned.length > quote.length) {
        baseAsset = cleaned.slice(0, cleaned.length - quote.length);
        quoteAsset = quote;
        break;
      }
    }

    if (!baseAsset) {
      baseAsset = cleaned;
    }

    const formatted = `${baseAsset}/${quoteAsset}`;
    const rawSymbol = `${baseAsset}${quoteAsset}`;
    return ok(new Symbol(rawSymbol, baseAsset, quoteAsset, formatted));
  }

  public equals(other: Symbol): boolean {
    return this.raw === other.raw;
  }

  public toString(): string {
    return this.formatted;
  }
}
