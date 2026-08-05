import { describe, it, expect } from 'vitest';
import { SecurityAwareCache } from './SecurityAwareCache';

describe('Milestone 5 — SecurityAwareCache Tenant & Version Isolation Unit Tests', () => {
  it('SecurityAwareCache stores and retrieves cached values using SHA-256 tenant keys', async () => {
    const cache = new SecurityAwareCache<any>();
    await cache.set('usr_10', 'mainnet', 'binance', 1, '/api/v3/account', { balance: 5000 });

    const val = await cache.get('usr_10', 'mainnet', 'binance', 1, '/api/v3/account');
    expect(val).toEqual({ balance: 5000 });
  });

  it('SecurityAwareCache naturally invalidates cache entries when credential version increments', async () => {
    const cache = new SecurityAwareCache<any>();
    await cache.set('usr_10', 'mainnet', 'binance', 1, '/api/v3/account', { balance: 5000 });

    // Version 1 exists
    expect(await cache.get('usr_10', 'mainnet', 'binance', 1, '/api/v3/account')).toEqual({ balance: 5000 });

    // Rotate credential -> version becomes 2 -> old cache entry inaccessible!
    const v2Val = await cache.get('usr_10', 'mainnet', 'binance', 2, '/api/v3/account');
    expect(v2Val).toBeNull();
  });

  it('SecurityAwareCache prevents cross-tenant and cross-environment cache poisoning', async () => {
    const cache = new SecurityAwareCache<any>();
    await cache.set('usr_10', 'mainnet', 'binance', 1, '/api/v3/account', { balance: 5000 });

    // Tenant 2 attempts to query same path -> returns null
    expect(await cache.get('usr_99', 'mainnet', 'binance', 1, '/api/v3/account')).toBeNull();

    // Testnet environment attempts to query mainnet path -> returns null
    expect(await cache.get('usr_10', 'testnet', 'binance', 1, '/api/v3/account')).toBeNull();
  });
});
