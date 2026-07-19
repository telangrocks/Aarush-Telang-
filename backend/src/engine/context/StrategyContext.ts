import { MarketSnapshot } from '../market-data/MarketSnapshot';

export class StrategyContext {
  public readonly timestamp: number;
  public readonly marketSnapshot: Readonly<MarketSnapshot>;

  constructor(marketSnapshot: MarketSnapshot) {
    this.timestamp = Date.now();
    this.marketSnapshot = Object.freeze(marketSnapshot);
  }

  // Prevents any modification to the context object after it's created
  public freeze(): Readonly<StrategyContext> {
    return Object.freeze(this);
  }
}
