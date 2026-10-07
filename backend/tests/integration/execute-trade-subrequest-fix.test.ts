import { describe, it, expect, vi, beforeEach } from 'vitest';
import BigNumber from 'bignumber.js';
import { BybitAdapter } from '../../src/infrastructure/exchange/adapters/BybitAdapter';
import { TradingBot } from '../../src/trading-bot';
import { ExchangeManager } from '../../src/exchanges';

vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('mock_decrypted_secret'),
  encrypt: vi.fn().mockResolvedValue({ iv: 'iv', encrypted: 'enc', salt: 'salt' }),
  cleanCredential: vi.fn().mockImplementation((k) => k)
}));

describe('Patch 1: Subrequest Fix Verification Tests', () => {
  describe('BybitAdapter.fetchMarket() Targeted Linear Lookup', () => {
    it('proves fetchMarket makes exactly 1 HTTP GET request targeting category=linear and exact symbol', async () => {
      const adapter = new BybitAdapter();
      await adapter.connect({
        apiKey: 'test-key',
        secret: 'test-secret',
        environment: 'testnet',
      });

      const requestCalls: any[] = [];
      (adapter as any).makeRequest = vi.fn().mockImplementation(async (method: string, path: string, params: any) => {
        requestCalls.push({ method, path, params });
        return {
          category: 'linear',
          list: [
            {
              symbol: 'HYPEUSDT',
              baseCoin: 'HYPE',
              quoteCoin: 'USDT',
              status: 'Trading',
              lotSizeFilter: {
                basePrecision: '0.1',
                quotePrecision: '0.01',
                minOrderQty: '0.1',
                maxOrderQty: '10000.0',
                minNotionalValue: '5.0',
                qtyStep: '0.1',
              },
              priceFilter: {
                minPrice: '0.01',
                maxPrice: '1999.99',
                tickSize: '0.01',
              },
              priceLimitRatioX: '0.05',
              priceLimitRatioY: '0.05',
            },
          ],
        };
      });

      const market = await adapter.fetchMarket('HYPE/USDT');

      // 1. Exactly 1 request made
      expect(requestCalls.length).toBe(1);
      expect((adapter as any).makeRequest).toHaveBeenCalledTimes(1);

      // 2. Exact requested endpoint and params
      expect(requestCalls[0]).toEqual({
        method: 'GET',
        path: '/v5/market/instruments-info',
        params: {
          category: 'linear',
          symbol: 'HYPEUSDT',
        },
      });

      // 3. Authoritative metadata mapped properly
      expect(market).not.toBeNull();
      expect(market!.id).toBe('HYPEUSDT');
      expect(market!.symbol).toBe('HYPE/USDT');
      expect(market!.category).toBe('linear');
      expect(market!.active).toBe(true);
      expect(market!.precision.price).toBe(0.01);
      expect(market!.precision.amount).toBe(0.1);
      expect(market!.limits.cost.min.toNumber()).toBe(5.0);
      expect(market!.limits.amount.min.toNumber()).toBe(0.1);
      expect((market as any).priceLimitRatioX).toBe(0.05);
    });

    it('proves fetchMarket returns null and does NOT fall back to Spot when Linear symbol is absent', async () => {
      const adapter = new BybitAdapter();
      await adapter.connect({
        apiKey: 'test-key',
        secret: 'test-secret',
        environment: 'testnet',
      });

      const requestCalls: any[] = [];
      (adapter as any).makeRequest = vi.fn().mockImplementation(async (method: string, path: string, params: any) => {
        requestCalls.push({ method, path, params });
        return {
          category: 'linear',
          list: [],
        };
      });

      const market = await adapter.fetchMarket('UNKNOWN/USDT');

      // Returned null safely
      expect(market).toBeNull();

      // Only 1 request was attempted; ZERO Spot calls
      expect(requestCalls.length).toBe(1);
      expect(requestCalls[0].params.category).toBe('linear');
      expect(requestCalls.some(r => r.params?.category === 'spot')).toBe(false);
    });

    it('proves fetchMarket returns null when instrument status is not Trading', async () => {
      const adapter = new BybitAdapter();
      await adapter.connect({
        apiKey: 'test-key',
        secret: 'test-secret',
        environment: 'testnet',
      });

      (adapter as any).makeRequest = vi.fn().mockResolvedValue({
        category: 'linear',
        list: [
          {
            symbol: 'DELISTEDUSDT',
            baseCoin: 'DELISTED',
            quoteCoin: 'USDT',
            status: 'Delisted',
          },
        ],
      });

      const market = await adapter.fetchMarket('DELISTED/USDT');
      expect(market).toBeNull();
    });

    it('proves fetchMarkets (full catalog discovery) remains intact for Scanner use', async () => {
      const adapter = new BybitAdapter();
      await adapter.connect({
        apiKey: 'test-key',
        secret: 'test-secret',
        environment: 'testnet',
      });

      (adapter as any).makeRequest = vi.fn().mockResolvedValue({
        category: 'linear',
        list: [
          {
            symbol: 'BTCUSDT',
            baseCoin: 'BTC',
            quoteCoin: 'USDT',
            status: 'Trading',
            lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', minNotionalValue: '5.0' },
            priceFilter: { tickSize: '0.1' },
          },
          {
            symbol: 'ETHUSDT',
            baseCoin: 'ETH',
            quoteCoin: 'USDT',
            status: 'Trading',
            lotSizeFilter: { qtyStep: '0.01', minOrderQty: '0.01', minNotionalValue: '5.0' },
            priceFilter: { tickSize: '0.01' },
          },
        ],
        nextPageCursor: undefined,
      });

      const markets = await adapter.fetchMarkets();
      expect(markets.length).toBe(2);
      expect(markets[0].symbol).toBe('BTC/USDT');
      expect(markets[1].symbol).toBe('ETH/USDT');
    });
  });

  describe('TradingBot.executeTrade() Zero-fetchMarkets Verification', () => {
    let mockStorage: Map<string, any>;
    let mockState: any;
    let mockDb: any;
    let mockEnv: any;
    let fetchMarketsSpy: any;
    let fetchMarketSpy: any;
    let createOrderSpy: any;

    beforeEach(() => {
      mockStorage = new Map<string, any>();
      mockState = {
        storage: {
          get: vi.fn().mockImplementation(async (key: string) => mockStorage.get(key)),
          put: vi.fn().mockImplementation(async (key: string, val: any) => {
            mockStorage.set(key, val);
          }),
          delete: vi.fn().mockImplementation(async (key: string) => {
            mockStorage.delete(key);
          }),
          list: vi.fn().mockImplementation(async () => new Map()),
          transaction: vi.fn().mockImplementation(async (closure: any) => {
            return closure({
              get: vi.fn().mockImplementation(async (k: string) => mockStorage.get(k)),
              put: vi.fn().mockImplementation(async (k: string, v: any) => mockStorage.set(k, v)),
              delete: vi.fn().mockImplementation(async (k: string) => mockStorage.delete(k)),
            });
          }),
        },
        blockConcurrencyWhile: vi.fn().mockImplementation(async (cb: any) => cb()),
      };

      mockDb = {
        prepare: vi.fn().mockImplementation((query: string) => {
          if (query.includes("PRAGMA table_info('trade_positions')")) {
            return {
              all: vi.fn().mockResolvedValue({
                results: [
                  { name: 'target_entry_price' },
                  { name: 'entry_status' },
                ],
              }),
            };
          }
          return {
            bind: vi.fn().mockReturnValue({
              run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
              first: vi.fn().mockImplementation(async () => {
                if (query.includes('FROM users')) {
                  return {
                    exchange_name: 'bybit',
                    exchange_environment: 'demo',
                    exchange_region: 'global',
                    exchange_api_key: 'test_key',
                    exchange_api_secret_encrypted: 'mock_encrypted_secret',
                    exchange_api_secret_iv: 'mock_iv',
                    exchange_api_secret_salt: 'mock_salt',
                  };
                }
                return null;
              }),
              all: vi.fn().mockResolvedValue({ results: [] }),
            }),
            all: vi.fn().mockResolvedValue({ results: [] }),
            run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
          };
        }),
      };

      mockEnv = {
        DB: mockDb,
        ENVIRONMENT: 'testnet',
        REGION: 'global',
        GLOBAL_TRADING_HALT: 'false',
        APP_INSTANCE_ID: 'inst_1',
        BOT_TOKEN_SALT: 'salt_123',
      };

      mockStorage.set('userId', 'usr_test');
      mockStorage.set('strategy', 'ScalperV2');

      fetchMarketsSpy = vi.fn().mockResolvedValue([]);
      fetchMarketSpy = vi.fn().mockResolvedValue({
        id: 'HYPEUSDT',
        symbol: 'HYPE/USDT',
        base: 'HYPE',
        quote: 'USDT',
        category: 'linear',
        active: true,
        precision: { price: 0.01, amount: 0.1 },
        limits: {
          cost: { min: new BigNumber(5) },
          amount: { min: new BigNumber(0.1) },
          price: { min: new BigNumber(0.01) },
        },
      });
      createOrderSpy = vi.fn().mockResolvedValue({
        id: 'bybit_order_hype_123',
        symbol: 'HYPE/USDT',
        amount: new BigNumber(1),
        average: new BigNumber(88.07),
        status: 'closed',
      });

      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
        fetchTicker: vi.fn().mockResolvedValue({ last: 88.07 }),
        fetchPositions: vi.fn().mockResolvedValue([]),
        fetchBalance: vi.fn().mockResolvedValue([
          { currency: 'USDT', free: new BigNumber(1000), total: new BigNumber(1000) }
        ]),
        fetchMarkets: fetchMarketsSpy,
        fetchMarket: fetchMarketSpy,
        createOrder: createOrderSpy,
        supportsOco: vi.fn().mockReturnValue(false),
      } as any);

      vi.spyOn(ExchangeManager, 'executeIdempotentOrder').mockImplementation(async (adapter: any, req: any) => {
        return adapter.createOrder(req);
      });
    });

    it('proves executeTrade calls fetchMarket exactly once and makes ZERO calls to fetchMarkets', async () => {
      const bot = new TradingBot(mockState, mockEnv);

      // Register valid alert
      const alertId = '8318ded3-9bf8-4a3f-953e-cb77d84c082f';
      const tradeAlert = {
        id: alertId,
        symbol: 'HYPE/USDT',
        strategy: 'ScalperV2',
        side: 'BUY' as const,
        targetEntryPrice: 88.07,
        entryIntent: 'IMMEDIATE',
        entryPrice: 88.07,
        signalPrice: 88.07,
        stopLoss: 87.86,
        takeProfit: 88.35,
        positionSize: 25.00,
        estimatedPnl: 1.85,
        timestamp: new Date().toISOString(),
        status: 'pending',
      };

      const regReq = new Request('http://bot/register-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert: tradeAlert }),
      });
      const regRes = await bot.fetch(regReq);
      expect(regRes.status).toBe(200);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId }),
      });

      const res = await bot.fetch(req);
      const data = await res.json<any>();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);

      // CRITICAL ASSERTION: ZERO calls to fetchMarkets()
      expect(fetchMarketsSpy).toHaveBeenCalledTimes(0);

      // Targeted lookup called with exact alerted symbol
      expect(fetchMarketSpy).toHaveBeenCalledTimes(1);
      expect(fetchMarketSpy).toHaveBeenCalledWith('HYPE/USDT');

      // Order created successfully
      expect(createOrderSpy).toHaveBeenCalledTimes(1);
    });

    it('proves executeTrade fails closed immediately before createOrder when metadata is null', async () => {
      fetchMarketSpy.mockResolvedValue(null);
      const bot = new TradingBot(mockState, mockEnv);

      const alertId = 'alert_null_meta';
      const tradeAlert = {
        id: alertId,
        symbol: 'HYPE/USDT',
        strategy: 'ScalperV2',
        side: 'BUY' as const,
        targetEntryPrice: 88.07,
        entryIntent: 'IMMEDIATE',
        entryPrice: 88.07,
        signalPrice: 88.07,
        stopLoss: 87.86,
        takeProfit: 88.35,
        positionSize: 25.00,
        estimatedPnl: 1.85,
        timestamp: new Date().toISOString(),
        status: 'pending',
      };

      const regReq = new Request('http://bot/register-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert: tradeAlert }),
      });
      await bot.fetch(regReq);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId }),
      });

      const res = await bot.fetch(req);
      const data = await res.json<any>();

      // Fail-closed behavior: Order rejected before dispatch
      expect(data.success).toBe(false);
      expect(data.message).toContain('Authoritative exchange metadata for HYPE/USDT is unavailable');
      expect(createOrderSpy).toHaveBeenCalledTimes(0);
      expect(fetchMarketsSpy).toHaveBeenCalledTimes(0);
    });

    it('proves executeTrade fails closed immediately before createOrder when tickSize <= 0', async () => {
      fetchMarketSpy.mockResolvedValue({
        id: 'HYPEUSDT',
        symbol: 'HYPE/USDT',
        category: 'linear',
        active: true,
        precision: { price: 0, amount: 0.1 }, // Invalid tickSize 0!
        limits: {
          cost: { min: new BigNumber(5) },
          amount: { min: new BigNumber(0.1) },
          price: { min: new BigNumber(0.01) },
        },
      });
      const bot = new TradingBot(mockState, mockEnv);

      const alertId = 'alert_invalid_meta';
      const tradeAlert = {
        id: alertId,
        symbol: 'HYPE/USDT',
        strategy: 'ScalperV2',
        side: 'BUY' as const,
        targetEntryPrice: 88.07,
        entryIntent: 'IMMEDIATE',
        entryPrice: 88.07,
        signalPrice: 88.07,
        stopLoss: 87.86,
        takeProfit: 88.35,
        positionSize: 25.00,
        estimatedPnl: 1.85,
        timestamp: new Date().toISOString(),
        status: 'pending',
      };

      const regReq = new Request('http://bot/register-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert: tradeAlert }),
      });
      await bot.fetch(regReq);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId }),
      });

      const res = await bot.fetch(req);
      const data = await res.json<any>();

      // Fail-closed behavior: Order rejected before dispatch
      expect(data.success).toBe(false);
      expect(data.message).toContain('Cannot safely determine execution tick size');
      expect(createOrderSpy).toHaveBeenCalledTimes(0);
      expect(fetchMarketsSpy).toHaveBeenCalledTimes(0);
    });
  });
});
