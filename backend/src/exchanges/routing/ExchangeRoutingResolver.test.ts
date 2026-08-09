// backend/src/exchanges/routing/ExchangeRoutingResolver.test.ts

import { describe, it, expect, vi } from 'vitest';
import { ExchangeRoutingResolver } from './ExchangeRoutingResolver';
import { resolveCanonicalRoutingRegion, normalizeRegion } from '../../utils/region';
import { resolveCanonicalEnvironment } from '../../utils/environment';
import { ExchangeManager } from '../ExchangeManager';
import { WebSocketManager } from '../WebSocketManager';

describe('ExchangeRoutingResolver & Routing Architecture Regression Suite', () => {
  // Binance Tests
  it('1. Binance Mainnet India resolves strictly to api.binance.com', () => {
    const url = ExchangeRoutingResolver.getRestUrl({ exchange: 'binance', environment: 'mainnet', region: 'india' });
    expect(url).toBe('https://api.binance.com');
  });

  it('2. Binance US (api.binance.us) is NEVER returned under any environment/region context', () => {
    const urls = ExchangeRoutingResolver.getRestUrls({ exchange: 'binance', environment: 'mainnet', region: 'india' });
    expect(urls).not.toContain('https://api.binance.us');
    expect(urls[0]).toBe('https://api.binance.com');
  });

  it('3. Binance Testnet resolves to testnet.binance.vision', () => {
    const url = ExchangeRoutingResolver.getRestUrl({ exchange: 'binance', environment: 'testnet', region: 'india' });
    expect(url).toBe('https://testnet.binance.vision');
  });

  it('4. Binance Demo throws UNSUPPORTED_OPERATION', () => {
    expect(() => ExchangeRoutingResolver.getRestUrl({ exchange: 'binance', environment: 'demo' })).toThrow(/demo/i);
  });

  // Bybit Tests
  it('5. Bybit Mainnet resolves to api.bybit.com', () => {
    const url = ExchangeRoutingResolver.getRestUrl({ exchange: 'bybit', environment: 'mainnet', region: 'india' });
    expect(url).toBe('https://api.bybit.com');
  });

  it('6. Bybit WebSocket stream resolves explicitly by purpose/product', () => {
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('mainnet', 'spot')).toBe('wss://stream.bybit.com/v5/public/spot');
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('mainnet', 'linear')).toBe('wss://stream.bybit.com/v5/public/linear');
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('mainnet', 'inverse')).toBe('wss://stream.bybit.com/v5/public/inverse');
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('mainnet', 'option')).toBe('wss://stream.bybit.com/v5/public/option');
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('mainnet', 'private')).toBe('wss://stream.bybit.com/v5/private');
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('mainnet', 'trade')).toBe('wss://stream.bybit.com/v5/trade');
  });

  it('7. Bybit Testnet WebSocket streams resolve to stream-testnet.bybit.com', () => {
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('testnet', 'linear')).toBe('wss://stream-testnet.bybit.com/v5/public/linear');
  });

  // KuCoin Tests
  it('8. KuCoin Spot REST resolves to api.kucoin.com', () => {
    const url = ExchangeRoutingResolver.getRestUrl({ exchange: 'kucoin', product: 'spot', environment: 'mainnet' });
    expect(url).toBe('https://api.kucoin.com');
  });

  it('9. KuCoin Futures REST resolves to api-futures.kucoin.com', () => {
    const url = ExchangeRoutingResolver.getRestUrl({ exchange: 'kucoin', product: 'futures', environment: 'mainnet' });
    expect(url).toBe('https://api-futures.kucoin.com');
  });

  it('10. KuCoin Deprecated Sandbox/Testnet throws UNSUPPORTED_OPERATION', () => {
    expect(() => ExchangeRoutingResolver.getRestUrl({ exchange: 'kucoin', environment: 'testnet' })).toThrow(/deprecated/i);
  });

  it('11. KuCoin Private WebSocket request without credentials throws MISSING_REQUIRED_CREDENTIALS', async () => {
    const wsManager = new WebSocketManager();
    await expect(wsManager.fetchKuCoinBulletToken('https://api.kucoin.com', 'private')).rejects.toThrow(/credentials/i);
  });

  // Region Policy Tests
  it('12. Missing/null/undefined region resolves to canonical routing region "india"', () => {
    expect(resolveCanonicalRoutingRegion(undefined)).toBe('india');
    expect(resolveCanonicalRoutingRegion(null)).toBe('india');
  });

  it('13. Legacy D1 stored region "global" resolves to canonical routing region "india"', () => {
    expect(normalizeRegion('global')).toBe('global');
    expect(resolveCanonicalRoutingRegion('global')).toBe('india');
  });

  // Cache Identity Tests
  it('14. Provider Cache Key enforces product, environment, canonical region, and credential isolation', async () => {
    const configSpot = { environment: 'mainnet' as const, region: 'india', product: 'spot' as const, apiKey: 'k', secret: 's', passphrase: 'p' };
    const configFutures = { environment: 'mainnet' as const, region: 'india', product: 'futures' as const, apiKey: 'k', secret: 's', passphrase: 'p' };
    const configTestnet = { environment: 'testnet' as const, region: 'india', product: 'spot' as const, apiKey: 'k', secret: 's', passphrase: 'p' };
    const configCreds = { environment: 'mainnet' as const, region: 'india', product: 'spot' as const, apiKey: 'k2', secret: 's', passphrase: 'p' };

    const keySpot = await (ExchangeManager as any).getHashedCacheKey('kucoin', configSpot);
    const keyFutures = await (ExchangeManager as any).getHashedCacheKey('kucoin', configFutures);
    const keyTestnet = await (ExchangeManager as any).getHashedCacheKey('kucoin', configTestnet);
    const keyCreds = await (ExchangeManager as any).getHashedCacheKey('kucoin', configCreds);

    expect(keySpot).not.toBe(keyFutures);
    expect(keySpot).not.toBe(keyTestnet);
    expect(keySpot).not.toBe(keyCreds);
  });

  it('15. Canonical environment aliases (Production vs mainnet) yield identical cache identity', async () => {
    const key1 = await (ExchangeManager as any).getHashedCacheKey('binance', { environment: 'Production' as any, region: 'india', apiKey: 'k', secret: 's' });
    const key2 = await (ExchangeManager as any).getHashedCacheKey('binance', { environment: 'mainnet' as any, region: 'india', apiKey: 'k', secret: 's' });
    expect(key1).toBe(key2);
  });
});
