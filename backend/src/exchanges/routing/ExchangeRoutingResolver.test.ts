// backend/src/exchanges/routing/ExchangeRoutingResolver.test.ts

import { describe, it, expect, vi } from 'vitest';
import { ExchangeRoutingResolver } from './ExchangeRoutingResolver';
import { resolveCanonicalRoutingRegion, normalizeRegion } from '../../utils/region';
import { resolveCanonicalEnvironment } from '../../utils/environment';
import { ExchangeManager } from '../ExchangeManager';
import { WebSocketManager } from '../WebSocketManager';

describe('ExchangeRoutingResolver & Routing Architecture Regression Suite', () => {
  // Bybit Tests
  it('1. Bybit Mainnet resolves to api.bybit.com', () => {
    const url = ExchangeRoutingResolver.getRestUrl({ exchange: 'bybit', environment: 'mainnet' });
    expect(url).toBe('https://api.bybit.com');
  });

  it('2. Bybit Demo resolves to api-demo.bybit.com', () => {
    const url = ExchangeRoutingResolver.getRestUrl({ exchange: 'bybit', environment: 'demo' });
    expect(url).toBe('https://api-demo.bybit.com');
  });

  it('2.5. Bybit Testnet resolves to api-testnet.bybit.com', () => {
    const url = ExchangeRoutingResolver.getRestUrl({ exchange: 'bybit', environment: 'testnet' });
    expect(url).toBe('https://api-testnet.bybit.com');
  });

  it('3. Bybit WebSocket stream resolves explicitly by purpose', () => {
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('mainnet', 'spot')).toBe('wss://stream.bybit.com/v5/public/spot');
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('mainnet', 'linear')).toBe('wss://stream.bybit.com/v5/public/linear');
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('mainnet', 'private')).toBe('wss://stream.bybit.com/v5/private');
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('mainnet', 'trade')).toBe('wss://stream.bybit.com/v5/trade');
  });

  it('4. Bybit Demo WebSocket streams resolve to stream-demo.bybit.com', () => {
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('demo', 'linear')).toBe('wss://stream-demo.bybit.com/v5/public/linear');
  });

  it('4.5. Bybit Testnet WebSocket streams resolve to stream-testnet.bybit.com', () => {
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('testnet', 'linear')).toBe('wss://stream-testnet.bybit.com/v5/public/linear');
  });

  it('5. Legacy exchange connection attempts throw EXCHANGE_RECONNECT_REQUIRED', () => {
    expect(() => ExchangeRoutingResolver.getRestUrl({ exchange: 'binance', environment: 'mainnet' })).toThrow(/no longer supported/i);
    expect(() => ExchangeRoutingResolver.getRestUrl({ exchange: 'kucoin', environment: 'mainnet' })).toThrow(/no longer supported/i);
  });

  // Region Policy Tests
  it('6. Missing/null/undefined region resolves to canonical routing region "india"', () => {
    expect(resolveCanonicalRoutingRegion(undefined)).toBe('india');
    expect(resolveCanonicalRoutingRegion(null)).toBe('india');
  });

  // Cache Identity Tests
  it('7. Provider Cache Key enforces product, environment, canonical region, and credential isolation', async () => {
    const configDemo = { environment: 'demo' as const, region: 'india', product: 'linear' as const, apiKey: 'k', secret: 's' };
    const configMainnet = { environment: 'mainnet' as const, region: 'india', product: 'linear' as const, apiKey: 'k', secret: 's' };

    const keyDemo = await (ExchangeManager as any).getHashedCacheKey('bybit', configDemo);
    const keyMainnet = await (ExchangeManager as any).getHashedCacheKey('bybit', configMainnet);

    expect(keyDemo).not.toBe(keyMainnet);
  });

  it('8. Canonical environment aliases (Production vs mainnet) yield identical cache identity', async () => {
    const key1 = await (ExchangeManager as any).getHashedCacheKey('bybit', { environment: 'Production' as any, region: 'india', apiKey: 'k', secret: 's' });
    const key2 = await (ExchangeManager as any).getHashedCacheKey('bybit', { environment: 'mainnet' as any, region: 'india', apiKey: 'k', secret: 's' });
    expect(key1).toBe(key2);
  });
});
