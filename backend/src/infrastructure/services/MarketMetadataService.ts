/* eslint-disable @typescript-eslint/ban-types */
import { LruTtlCache } from '../cache/LruTtlCache';
import { Symbol } from '../../domain/value-objects/Symbol';
import { Price } from '../../domain/value-objects/Price';
import { Quantity } from '../../domain/value-objects/Quantity';
import { Money } from '../../domain/value-objects/Money';

export interface MarketRulesSnapshot {
  readonly snapshotId: string;
  readonly version: number;
  readonly timestamp: number;
  readonly symbol: Symbol;
  readonly minPrice: Price;
  readonly maxPrice: Price;
  readonly tickSize: Price;
  readonly minQty: Quantity;
  readonly maxQty: Quantity;
  readonly stepSize: Quantity;
  readonly minNotional: Money;
}

export class MarketMetadataService {
  private cache = new LruTtlCache<string, MarketRulesSnapshot>(100, 24 * 60 * 60 * 1000); // 24 hours

  public getSnapshot(symbolInput: string): MarketRulesSnapshot {
    const symRes = Symbol.create(symbolInput);
    const sym = symRes.isSuccess ? symRes.value : (Symbol.create('BTC/USDT') as any).value;
    const cacheKey = sym.raw;

    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    // Create default fallback snapshot if not in cache
    const minPriceRes = Price.create(0.01);
    const maxPriceRes = Price.create(1000000);
    const tickSizeRes = Price.create(0.01);
    const minQtyRes = Quantity.create(0.00001);
    const maxQtyRes = Quantity.create(9999);
    const stepSizeRes = Quantity.create(0.00001);
    const minNotionalRes = Money.create(10, 'USDT');

    const snapshot: MarketRulesSnapshot = {
      snapshotId: crypto.randomUUID(),
      version: 1,
      timestamp: Date.now(),
      symbol: sym,
      minPrice: minPriceRes.isSuccess ? minPriceRes.value : (Price.create(0.01) as any).value,
      maxPrice: maxPriceRes.isSuccess ? maxPriceRes.value : (Price.create(1000000) as any).value,
      tickSize: tickSizeRes.isSuccess ? tickSizeRes.value : (Price.create(0.01) as any).value,
      minQty: minQtyRes.isSuccess ? minQtyRes.value : (Quantity.create(0.00001) as any).value,
      maxQty: maxQtyRes.isSuccess ? maxQtyRes.value : (Quantity.create(9999) as any).value,
      stepSize: stepSizeRes.isSuccess ? stepSizeRes.value : (Quantity.create(0.00001) as any).value,
      minNotional: minNotionalRes.isSuccess ? minNotionalRes.value : (Money.create(10, 'USDT') as any).value,
    };

    this.cache.set(cacheKey, snapshot);
    return snapshot;
  }

  public setSnapshot(snapshot: MarketRulesSnapshot): void {
    this.cache.set(snapshot.symbol.raw, snapshot);
  }
}
