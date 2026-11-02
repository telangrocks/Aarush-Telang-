export interface CacheEntry<V> {
  readonly value: V;
  readonly expiresAt: number;
}

export class LruTtlCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(
    private readonly maxCapacity: number = 50,
    private readonly ttlMs: number = 15 * 60 * 1000 // 15 minutes
  ) {}

  public set(key: K, value: V, customTtlMs?: number): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxCapacity) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        this.evictions++;
      }
    }

    const ttl = customTtlMs ?? this.ttlMs;
    const expiresAt = Date.now() + ttl;
    this.cache.set(key, { value, expiresAt });
  }

  public get(key: K): V | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    // Refresh LRU order
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  public has(key: K): boolean {
    return this.get(key) !== null;
  }

  public delete(key: K): boolean {
    return this.cache.delete(key);
  }

  public clear(): void {
    this.cache.clear();
  }

  public keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  public getStats() {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.cache.size,
      maxCapacity: this.maxCapacity,
    };
  }

  public size(): number {
    // Purge expired entries
    const now = Date.now();
    for (const [k, v] of this.cache.entries()) {
      if (now > v.expiresAt) {
        this.cache.delete(k);
      }
    }
    return this.cache.size;
  }
}
