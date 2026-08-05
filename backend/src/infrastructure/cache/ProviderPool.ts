import { LruTtlCache } from './LruTtlCache';
import { WebCryptoSigner } from '../crypto/WebCryptoSigner';
import { IExchangeProvider } from '../../exchanges/IExchangeProvider';

export class ProviderPool {
  private cache: LruTtlCache<string, IExchangeProvider>;

  constructor(maxCapacity: number = 50, ttlMs: number = 15 * 60 * 1000) {
    this.cache = new LruTtlCache<string, IExchangeProvider>(maxCapacity, ttlMs);
  }

  public async generateCacheKey(
    exchangeId: string,
    environment: string,
    apiKey: string = '',
    secret: string = ''
  ): Promise<string> {
    const rawKey = `${exchangeId}:${environment}:${apiKey}:${secret}`;
    const digest = await WebCryptoSigner.hashSha256(rawKey);
    return `${exchangeId}:${environment}:${digest}`;
  }

  public get(cacheKey: string): IExchangeProvider | null {
    return this.cache.get(cacheKey);
  }

  public set(cacheKey: string, provider: IExchangeProvider): void {
    this.cache.set(cacheKey, provider);
  }

  public delete(cacheKey: string): boolean {
    const provider = this.cache.get(cacheKey);
    if (provider) {
      provider.disconnect().catch(() => {});
    }
    return this.cache.delete(cacheKey);
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size();
  }
}
