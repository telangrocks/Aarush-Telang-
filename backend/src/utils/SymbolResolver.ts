export interface ResolvedSymbol {
  symbol: string;     // e.g. "BTCUSDT"
  baseAsset: string;  // e.g. "BTC"
  quoteAsset: string; // e.g. "USDT"
}

export class SymbolResolver {
  private static KNOWN_QUOTES = ["USDT", "BUSD", "USD", "USDC", "BTC", "ETH"];

  /**
   * Normalizes any input symbol string (e.g. "btc", "BTC/USDT", "BTC-USDT", "BTCUSDT")
   * into a standardized upper-case symbol format and extracts base/quote assets.
   */
  public static resolve(inputSymbol: string, defaultQuote: string = "USDT"): ResolvedSymbol {
    if (!inputSymbol || typeof inputSymbol !== "string") {
      throw new Error("Invalid symbol input: must be a non-empty string.");
    }

    const cleaned = inputSymbol.trim().toUpperCase().replace(/[/\s_-]/g, "");

    // If cleaned string ends with any known quote currency
    for (const quote of this.KNOWN_QUOTES) {
      if (cleaned.endsWith(quote) && cleaned.length > quote.length) {
        const base = cleaned.slice(0, cleaned.length - quote.length);
        return {
          symbol: cleaned,
          baseAsset: base,
          quoteAsset: quote,
        };
      }
    }

    // Default case: Treat input as base asset (e.g. "BTC" -> "BTCUSDT")
    const quote = defaultQuote.toUpperCase();
    return {
      symbol: `${cleaned}${quote}`,
      baseAsset: cleaned,
      quoteAsset: quote,
    };
  }

  /**
   * Returns standard cache key representation for exchange metadata maps.
   */
  public static toCacheKey(inputSymbol: string, defaultQuote: string = "USDT"): string {
    return this.resolve(inputSymbol, defaultQuote).symbol;
  }
}
