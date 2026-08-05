import { LruTtlCache } from '../cache/LruTtlCache';
import { WebCryptoSigner } from '../crypto/WebCryptoSigner';

export class SecurityAwareCache<T = unknown> {
  private innerCache: LruTtlCache<string, T>;

  constructor(maxEntries: number = 200, defaultTtlMs: number = 300000) {
    this.innerCache = new LruTtlCache<string, T>(maxEntries, defaultTtlMs);
  }

  public async generateTenantCacheKey(
    userId: string,
    environment: string,
    exchangeId: string,
    credentialVersion: number,
    resourcePath: string
  ): Promise<string> {
    const rawKey = `${userId}:${environment}:${exchangeId}:v${credentialVersion}:${resourcePath}`;
    const hash = await WebCryptoSigner.hashSha256(rawKey);
    return `sec_cache:${hash}`;
  }

  public async get(
    userId: string,
    environment: string,
    exchangeId: string,
    credentialVersion: number,
    resourcePath: string
  ): Promise<T | null> {
    const key = await this.generateTenantCacheKey(userId, environment, exchangeId, credentialVersion, resourcePath);
    return this.innerCache.get(key);
  }

  public async set(
    userId: string,
    environment: string,
    exchangeId: string,
    credentialVersion: number,
    resourcePath: string,
    value: T,
    ttlMs?: number
  ): Promise<string> {
    const key = await this.generateTenantCacheKey(userId, environment, exchangeId, credentialVersion, resourcePath);
    this.innerCache.set(key, value, ttlMs);
    return key;
  }
}
