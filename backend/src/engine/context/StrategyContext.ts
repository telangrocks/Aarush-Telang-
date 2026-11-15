import { MarketSnapshot } from '../market-data/MarketSnapshot';

export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  Object.getOwnPropertyNames(obj).forEach((prop) => {
    const val = (obj as any)[prop];
    if (typeof val === 'object' && val !== null && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  });
  return obj;
}

export class StrategyContext {
  public readonly timestamp: number;
  public readonly marketSnapshot: Readonly<MarketSnapshot>;
  public readonly accountBalance: number;

  constructor(marketSnapshot: MarketSnapshot, accountBalance?: number) {
    if (!marketSnapshot || !marketSnapshot.timestamp) {
      throw new Error('MarketSnapshot must have a valid timestamp');
    }
    this.timestamp = marketSnapshot.timestamp;
    this.accountBalance =
      typeof accountBalance === 'number' && Number.isFinite(accountBalance) && accountBalance > 0
        ? accountBalance
        : 0;
    this.marketSnapshot = deepFreeze(marketSnapshot);
  }

  public freeze(): Readonly<StrategyContext> {
    return deepFreeze(this);
  }
}
