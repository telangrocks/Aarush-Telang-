import { describe, it, expect } from 'vitest';
import { LruTtlCache } from './LruTtlCache';
import { WebCryptoSigner } from '../crypto/WebCryptoSigner';
import { ProviderPool } from './ProviderPool';

describe('Cache & WebCrypto Signer Unit Tests', () => {
  it('LruTtlCache respects max capacity and evicts oldest entry', () => {
    const cache = new LruTtlCache<string, number>(2, 10000);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size()).toBe(2);

    cache.set('c', 3); // 'a' evicted
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('LruTtlCache expires entries past TTL', async () => {
    const cache = new LruTtlCache<string, string>(10, 10); // 10ms TTL
    cache.set('short', 'value');
    expect(cache.get('short')).toBe('value');

    await new Promise(r => setTimeout(r, 20));
    expect(cache.get('short')).toBeNull();
  });

  it('WebCryptoSigner generates SHA-256 digests and HMAC signatures', async () => {
    const hash = await WebCryptoSigner.hashSha256('hello_world');
    expect(hash).toHaveLength(64);

    const hmacHex = await WebCryptoSigner.hmacSha256Hex('secret', 'payload');
    expect(hmacHex).toHaveLength(64);

    const hmacBase64 = await WebCryptoSigner.hmacSha256Base64('secret', 'payload');
    expect(hmacBase64.length).toBeGreaterThan(0);
  });

  it('ProviderPool hashes credentials with SHA-256 and manages provider keys safely', async () => {
    const pool = new ProviderPool(10, 60000);
    const key1 = await pool.generateCacheKey('binance', 'mainnet', 'key123', 'sec456');
    const key2 = await pool.generateCacheKey('binance', 'mainnet', 'key123', 'sec456');
    const key3 = await pool.generateCacheKey('binance', 'mainnet', 'key999', 'sec456');

    expect(key1).toBe(key2); // Deterministic
    expect(key1).not.toBe(key3); // Different API key produces different SHA-256 digest
    expect(key1.includes('key123')).toBe(false); // Plaintext key is NOT leaked in string
    expect(key1.includes('sec456')).toBe(false); // Plaintext secret is NOT leaked in string
  });
});
