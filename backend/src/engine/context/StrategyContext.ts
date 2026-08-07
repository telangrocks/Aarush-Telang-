import { MarketSnapshot } from '../market-data/MarketSnapshot';

export class StrategyContext {
  public readonly timestamp: number;
  public readonly marketSnapshot: Readonly<MarketSnapshot>;
  public readonly accountBalance: number;

  constructor(marketSnapshot: MarketSnapshot, accountBalance: number = 1000) {
    // Fix SE-16: Assign timestamp from snapshot timestamp
    this.timestamp = marketSnapshot.timestamp || Date.now();
    this.accountBalance = accountBalance > 0 ? accountBalance : 1000;

    // Fix SE-C4 & SE-15: Deep freeze snapshot and nested candle arrays
    if (marketSnapshot && marketSnapshot.candles) {
      for (const candleArray of Object.values(marketSnapshot.candles)) {
        if (Array.isArray(candleArray)) {
          for (const candle of candleArray) {
            Object.freeze(candle);
          }
          Object.freeze(candleArray);
        }
      }
      Object.freeze(marketSnapshot.candles);
    }
    this.marketSnapshot = Object.freeze(marketSnapshot);
  }

  // Prevents any modification to the context object after creation (Fix SE-17)
  public freeze(): Readonly<StrategyContext> {
    return Object.freeze(this);
  }
}
