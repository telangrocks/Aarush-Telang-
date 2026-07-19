export class StrategyContext {
  public readonly timestamp: number;
  // In a future sprint, this will contain the immutable data snapshots
  // public readonly marketData: ReadonlyMap<string, any>;
  // public readonly indicators: ReadonlyMap<string, any>;

  constructor() {
    this.timestamp = Date.now();
  }

  // Prevents any modification to the context object after it's created
  public freeze(): Readonly<StrategyContext> {
    return Object.freeze(this);
  }
}
