import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { Env } from '../../src/index';
import { encrypt } from '../../src/crypto';
import {
  handleValidateExchange,
  handleConnectExchange,
  handleGetExchangeStatus,
  handleGetExchangeBalances,
  handleGetPersonalizedMarketCandidates,
  handleGetTechnicalAnalysis,
} from '../../src/handlers/exchange';
import { TradingBot } from '../../src/trading-bot';
import { ExchangeManager } from '../../src/exchanges';
import { BybitAdapter } from '../../src/infrastructure/exchange/adapters/BybitAdapter';
import { UnifiedError } from '../../src/exchanges/models/UnifiedError';
import BigNumber from 'bignumber.js';

const TEST_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_USER_ID = 'user-logic1-test';

function createAuthedApp() {
  const app = new Hono<{ Bindings: Env; Variables: { jwtPayload: { sub: string } } }>();
  app.use('*', async (c, next) => {
    c.set('jwtPayload', { sub: TEST_USER_ID });
    await next();
  });
  app.post('/api/exchange/validate', handleValidateExchange);
  app.post('/api/exchange/connect', handleConnectExchange);
  app.get('/api/exchange/status', handleGetExchangeStatus);
  app.get('/api/exchange/balances', handleGetExchangeBalances);
  app.get('/api/market/candidates', handleGetPersonalizedMarketCandidates);
  app.post('/api/market/technical-analysis', handleGetTechnicalAnalysis);
  return app;
}

function createMockDurableObjectState(initialStorage: Record<string, any> = {}) {
  const store = new Map<string, any>(Object.entries(initialStorage));
  let scheduledAlarm: number | null = null;
  const setAlarmSpy = vi.fn(async (time: number) => {
    scheduledAlarm = time;
  });
  const deleteAlarmSpy = vi.fn(async () => {
    scheduledAlarm = null;
  });

  const storage = {
    get: vi.fn(async (keyOrKeys: string | string[]) => {
      if (Array.isArray(keyOrKeys)) {
        const out = new Map<string, any>();
        for (const k of keyOrKeys) {
          if (store.has(k)) out.set(k, store.get(k));
        }
        return out;
      }
      return store.get(keyOrKeys);
    }),
    put: vi.fn(async (key: string, val: any) => {
      store.set(key, val);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => new Map(store)),
    transaction: vi.fn(async (cb: (txn: any) => Promise<void>) => {
      await cb(storage);
    }),
    setAlarm: setAlarmSpy,
    deleteAlarm: deleteAlarmSpy,
    getAlarm: vi.fn(async () => scheduledAlarm),
  };

  return {
    state: {
      id: { toString: () => 'do-logic1-id' },
      storage,
      blockConcurrencyWhile: vi.fn(async (cb: () => Promise<void>) => await cb()),
    } as any,
    store,
    setAlarmSpy,
    deleteAlarmSpy,
    getScheduledAlarm: () => scheduledAlarm,
  };
}

describe('Logic 1 — Bybit Connection Four-Finding Final Repair Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Finding 2 — Durable Object Cached Credential Invalidation & Open-Position Safety', () => {
    it('1 & 2. Both active and inactive bot credential replacements deterministically invalidate DO cached credentials', async () => {
      for (const botInitiallyActive of [true, false]) {
        const oldEncKey = await encrypt('OLD_API_KEY_123456', TEST_ENC_KEY);
        const oldEncSec = await encrypt('OLD_API_SEC_123456', TEST_ENC_KEY);

        let userRecord: any = {
          id: TEST_USER_ID,
          exchange_name: 'bybit',
          exchange_environment: 'demo',
          exchange_region: 'india',
          exchange_connection_status: 'CONNECTED',
          exchange_api_key_iv: oldEncKey.iv,
          exchange_api_key_encrypted: oldEncKey.encrypted,
          exchange_api_key_salt: oldEncKey.salt,
          exchange_api_secret_iv: oldEncSec.iv,
          exchange_api_secret_encrypted: oldEncSec.encrypted,
          exchange_api_secret_salt: oldEncSec.salt,
        };

        const mockDb = {
          prepare: vi.fn((sql: string) => ({
            bind: vi.fn((...args: any[]) => ({
              first: vi.fn(async () => {
                if (sql.includes('FROM users')) return { ...userRecord };
                if (sql.includes('FROM trade_positions')) return null;
                return null;
              }),
              all: vi.fn(async () => ({ results: [] })),
              run: vi.fn(async () => {
                if (sql.startsWith('UPDATE users SET exchange_name = ?')) {
                  userRecord = {
                    ...userRecord,
                    exchange_name: args[0],
                    exchange_environment: args[1],
                    exchange_region: args[2],
                    exchange_api_key_iv: args[3],
                    exchange_api_key_encrypted: args[4],
                    exchange_api_key_salt: args[5],
                    exchange_api_secret_iv: args[6],
                    exchange_api_secret_encrypted: args[7],
                    exchange_api_secret_salt: args[8],
                  };
                }
                return { success: true };
              }),
            })),
          })),
        };

        const { state } = createMockDurableObjectState({
          isActive: botInitiallyActive,
          userId: TEST_USER_ID,
        });

        const botEnv: Env = {
          DB: mockDb as any,
          ENCRYPTION_KEY: TEST_ENC_KEY,
          JWT_SECRET: 'jwt-secret-12345678901234567890123456789012',
          TRADING_BOTS: {} as any,
        };

        const liveBot = new TradingBot(state, botEnv);
        // Prime the in-memory credential cache in the live DO instance
        const primed = await (liveBot as any).getOrLoadExchangeCredentials(TEST_USER_ID);
        expect(primed?.apiKey).toBe('OLD_API_KEY_123456');
        expect((liveBot as any).cachedCredentials?.apiKey).toBe('OLD_API_KEY_123456');

        const botFetchRequests: string[] = [];
        botEnv.TRADING_BOTS = {
          idFromName: vi.fn(() => 'do-id' as any),
          get: vi.fn(() => ({
            fetch: vi.fn(async (req: Request) => {
              const path = new URL(req.url).pathname;
              botFetchRequests.push(path);
              return liveBot.fetch(req);
            }),
          })),
        } as any;

        vi.spyOn(ExchangeManager, 'createUncachedProvider').mockResolvedValue({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          checkApiKeyPermissions: vi.fn().mockResolvedValue({
            isValid: true,
            readOnly: false,
            hasTradingPermission: true,
            hasWithdrawPermission: false,
            withdrawalVerificationStatus: 'DISABLED',
            permissions: {
              ContractTrade: ['Order', 'Position'],
              Spot: ['SpotTrade'],
              Wallet: ['AccountTransfer'],
            },
          }),
          fetchBalance: vi.fn().mockResolvedValue([]),
        } as any);
        vi.spyOn(ExchangeManager, 'disconnectProvider').mockResolvedValue(undefined);

        const app = createAuthedApp();
        const res = await app.request(
          '/api/exchange/connect',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              exchangeName: 'bybit',
              apiKey: 'NEW_API_KEY_789012',
              apiSecret: 'NEW_API_SEC_789012',
              environment: 'demo',
            }),
          },
          botEnv
        );

        expect(res.status).toBe(200);
        const body = await res.json<any>();
        expect(body.success).toBe(true);

        if (botInitiallyActive) {
          expect(botFetchRequests).toEqual(['/status', '/deactivate', '/reload-credentials']);
        } else {
          expect(botFetchRequests).toEqual(['/status', '/reload-credentials']);
        }

        // Verify DO in-memory cache was deterministically cleared
        expect((liveBot as any).cachedCredentials).toBeNull();

        // Verify subsequent DO credential load reads the newly persisted credentials from D1
        const reloaded = await (liveBot as any).getOrLoadExchangeCredentials(TEST_USER_ID);
        expect(reloaded?.apiKey).toBe('NEW_API_KEY_789012');
        expect(reloaded?.secret).toBe('NEW_API_SEC_789012');
      }
    });

    it('3 & 6. Open-position monitoring after credential replacement reloads new D1 credentials and preserves monitoring alarms across credential failures', async () => {
      const oldEncKey = await encrypt('STALE_KEY_111111', TEST_ENC_KEY);
      const oldEncSec = await encrypt('STALE_SEC_111111', TEST_ENC_KEY);
      const newEncKey = await encrypt('FRESH_KEY_222222', TEST_ENC_KEY);
      const newEncSec = await encrypt('FRESH_SEC_222222', TEST_ENC_KEY);

      let userRecord: any = {
        id: TEST_USER_ID,
        exchange_name: 'bybit',
        exchange_environment: 'demo',
        exchange_region: 'india',
        exchange_connection_status: 'CONNECTED',
        exchange_api_key_iv: oldEncKey.iv,
        exchange_api_key_encrypted: oldEncKey.encrypted,
        exchange_api_key_salt: oldEncKey.salt,
        exchange_api_secret_iv: oldEncSec.iv,
        exchange_api_secret_encrypted: oldEncSec.encrypted,
        exchange_api_secret_salt: oldEncSec.salt,
      };

      const openPositionRow = {
        id: 'pos-open-1',
        user_id: TEST_USER_ID,
        symbol: 'BTC/USDT',
        side: 'BUY',
        entry_price: 60000,
        quantity: 0.001,
        stop_loss: 58000,
        take_profit: 64000,
        status: 'OPEN',
        entry_status: 'FILLED',
        exchange: 'bybit',
        environment: 'demo',
      };

      const mockDb = {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn(() => ({
            first: vi.fn(async () => {
              if (sql.includes('FROM users')) return { ...userRecord };
              if (sql.includes('FROM trade_positions')) return openPositionRow;
              return null;
            }),
            all: vi.fn(async () => ({ results: [openPositionRow] })),
            run: vi.fn(async () => ({ success: true })),
          })),
        })),
      };

      const { state, setAlarmSpy, deleteAlarmSpy } = createMockDurableObjectState({
        isActive: false,
        userId: TEST_USER_ID,
        activePositions: [openPositionRow],
      });

      const botEnv: Env = {
        DB: mockDb as any,
        ENCRYPTION_KEY: TEST_ENC_KEY,
        JWT_SECRET: 'jwt-secret-12345678901234567890123456789012',
        TRADING_BOTS: {} as any,
      };

      const liveBot = new TradingBot(state, botEnv);
      await (liveBot as any).getOrLoadExchangeCredentials(TEST_USER_ID);
      expect((liveBot as any).cachedCredentials?.apiKey).toBe('STALE_KEY_111111');

      // Update D1 record to new credentials and invoke /reload-credentials on inactive bot with open position
      userRecord = {
        ...userRecord,
        exchange_api_key_iv: newEncKey.iv,
        exchange_api_key_encrypted: newEncKey.encrypted,
        exchange_api_key_salt: newEncKey.salt,
        exchange_api_secret_iv: newEncSec.iv,
        exchange_api_secret_encrypted: newEncSec.encrypted,
        exchange_api_secret_salt: newEncSec.salt,
      };

      const reloadRes = await liveBot.fetch(new Request('http://bot/reload-credentials', { method: 'POST' }));
      expect(reloadRes.status).toBe(200);
      expect(deleteAlarmSpy).not.toHaveBeenCalled();
      expect(setAlarmSpy).toHaveBeenCalled();

      const capturedGetProviderConfigs: any[] = [];
      vi.spyOn(ExchangeManager, 'getProvider').mockImplementation(async (_name, cfg) => {
        capturedGetProviderConfigs.push(cfg);
        return {
          fetchPositions: vi.fn().mockResolvedValue([
            { symbol: 'BTC/USDT', side: 'long', size: new BigNumber(0.001) },
          ]),
          fetchTicker: vi.fn().mockResolvedValue({ last: new BigNumber(60100) }),
        } as any;
      });

      await (liveBot as any).monitorOpenPositions();
      expect(capturedGetProviderConfigs.length).toBeGreaterThan(0);
      expect(capturedGetProviderConfigs[0].apiKey).toBe('FRESH_KEY_222222');
      expect(capturedGetProviderConfigs[0].secret).toBe('FRESH_SEC_222222');
      expect(capturedGetProviderConfigs[0].environment).toBe('demo');

      // Simulate broken/corrupted credentials in D1 during open-position monitoring
      userRecord = {
        ...userRecord,
        exchange_api_key_iv: 'corrupted-iv',
        exchange_api_key_encrypted: 'corrupted-ciphertext',
      };
      liveBot.invalidateCredentialsCache();

      const brokenCreds = await (liveBot as any).getOrLoadExchangeCredentials(TEST_USER_ID);
      expect(brokenCreds).toBeNull();
      expect((liveBot as any).cachedCredentials).toBeNull();
      // Open-position exposure remains true so monitoring alarm is never abandoned
      expect(await (liveBot as any).hasActiveExposure()).toBe(true);
    });

    it('4. Failed validation before D1 update does not overwrite existing valid credentials or corrupt active monitoring', async () => {
      const d1UpdateSpy = vi.fn();
      const botFetchSpy = vi.fn();

      const botEnv: Env = {
        DB: {
          prepare: vi.fn(() => ({
            bind: vi.fn(() => ({
              first: vi.fn(async () => ({
                exchange_name: 'bybit',
                exchange_environment: 'demo',
                exchange_region: 'india',
              })),
              run: d1UpdateSpy,
            })),
          })),
        } as any,
        ENCRYPTION_KEY: TEST_ENC_KEY,
        JWT_SECRET: 'jwt-secret-12345678901234567890123456789012',
        TRADING_BOTS: {
          idFromName: vi.fn(() => 'do-id' as any),
          get: vi.fn(() => ({ fetch: botFetchSpy })),
        } as any,
      };

      vi.spyOn(ExchangeManager, 'createUncachedProvider').mockResolvedValue({
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        checkApiKeyPermissions: vi.fn().mockRejectedValue(
          new UnifiedError('Invalid API key', 'AUTHENTICATION_FAILED', 10003, 'Invalid api_key', 401)
        ),
        fetchBalance: vi.fn(),
      } as any);

      const app = createAuthedApp();
      const res = await app.request(
        '/api/exchange/connect',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchangeName: 'bybit',
            apiKey: 'BAD_KEY_123456',
            apiSecret: 'BAD_SEC_123456',
            environment: 'demo',
          }),
        },
        botEnv
      );

      expect(res.status).toBe(400);
      const data = await res.json<any>();
      expect(data.success).toBe(false);
      expect(data.code).toBe('AUTHENTICATION_FAILED');
      expect(d1UpdateSpy).not.toHaveBeenCalled();
      expect(botFetchSpy).not.toHaveBeenCalled();
    });

    it('5. Failed DO cache invalidation after D1 update retries, returns 503 CREDENTIAL_CACHE_INVALIDATION_FAILED, and background DO monitoring/WAL reconciliation refuses stale cached credentials via D1 credential fingerprint verification', async () => {
      const oldEncKey = await encrypt('OLD_STALE_KEY_001', TEST_ENC_KEY);
      const oldEncSec = await encrypt('OLD_STALE_SEC_001', TEST_ENC_KEY);

      let userRecord: any = {
        id: TEST_USER_ID,
        exchange_name: 'bybit',
        exchange_environment: 'demo',
        exchange_region: 'india',
        exchange_connection_status: 'CONNECTED',
        exchange_api_key_iv: oldEncKey.iv,
        exchange_api_key_encrypted: oldEncKey.encrypted,
        exchange_api_key_salt: oldEncKey.salt,
        exchange_api_secret_iv: oldEncSec.iv,
        exchange_api_secret_encrypted: oldEncSec.encrypted,
        exchange_api_secret_salt: oldEncSec.salt,
      };

      const openPositionRow = {
        id: 'pos-open-stale-check',
        user_id: TEST_USER_ID,
        symbol: 'BTC/USDT',
        side: 'BUY',
        entry_price: 60000,
        quantity: 0.001,
        stop_loss: 58000,
        take_profit: 64000,
        status: 'OPEN',
        entry_status: 'FILLED',
        exchange: 'bybit',
        environment: 'demo',
      };

      const mockDb = {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn((...args: any[]) => ({
            first: vi.fn(async () => {
              if (sql.includes('FROM users')) return { ...userRecord };
              if (sql.includes('FROM trade_positions')) return openPositionRow;
              return null;
            }),
            all: vi.fn(async () => ({ results: [openPositionRow] })),
            run: vi.fn(async () => {
              if (sql.startsWith('UPDATE users SET exchange_name = ?')) {
                userRecord = {
                  ...userRecord,
                  exchange_name: args[0],
                  exchange_environment: args[1],
                  exchange_region: args[2],
                  exchange_api_key_iv: args[3],
                  exchange_api_key_encrypted: args[4],
                  exchange_api_key_salt: args[5],
                  exchange_api_secret_iv: args[6],
                  exchange_api_secret_encrypted: args[7],
                  exchange_api_secret_salt: args[8],
                };
              }
              return { success: true };
            }),
          })),
        })),
      };

      const { state, setAlarmSpy, deleteAlarmSpy } = createMockDurableObjectState({
        isActive: false,
        userId: TEST_USER_ID,
        activePositions: [openPositionRow],
        'wal:intent:intent-stale-check': {
          intentId: 'intent-stale-check',
          alertId: 'alert-stale-check',
          userId: TEST_USER_ID,
          symbol: 'BTC/USDT',
          side: 'BUY',
          quantity: '0.001',
          entryPrice: 60000,
          stopLoss: 58000,
          takeProfit: 64000,
          exchange: 'bybit',
          status: 'DISPATCHING',
          createdAt: Date.now() - 15_000,
          updatedAt: Date.now() - 15_000,
        },
      });

      let reloadAttempts = 0;
      const botEnv: Env = {
        DB: mockDb as any,
        ENCRYPTION_KEY: TEST_ENC_KEY,
        JWT_SECRET: 'jwt-secret-12345678901234567890123456789012',
        TRADING_BOTS: {} as any,
      };

      const liveBot = new TradingBot(state, botEnv);

      // Step 1: Old credentials are cached in a live Durable Object
      const initialCreds = await (liveBot as any).getOrLoadExchangeCredentials(TEST_USER_ID);
      expect(initialCreds?.apiKey).toBe('OLD_STALE_KEY_001');
      expect((liveBot as any).cachedCredentials?.apiKey).toBe('OLD_STALE_KEY_001');

      botEnv.TRADING_BOTS = {
        idFromName: vi.fn(() => 'do-id' as any),
        get: vi.fn(() => ({
          fetch: vi.fn(async (req: Request) => {
            const path = new URL(req.url).pathname;
            if (path === '/status') {
              return new Response(JSON.stringify({ isActive: false }), { status: 200 });
            }
            if (path === '/reload-credentials') {
              reloadAttempts++;
              // Step 3: /reload-credentials fails or times out on both attempts
              return new Response('DO reload timeout/failure', { status: 500 });
            }
            return liveBot.fetch(req);
          }),
        })),
      } as any;

      vi.spyOn(ExchangeManager, 'createUncachedProvider').mockResolvedValue({
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        checkApiKeyPermissions: vi.fn().mockResolvedValue({
          isValid: true,
          readOnly: false,
          hasTradingPermission: true,
          hasWithdrawPermission: false,
          withdrawalVerificationStatus: 'DISABLED',
          permissions: {
            ContractTrade: ['Order', 'Position'],
            Wallet: ['AccountTransfer', 'SubMemberTransfer'],
            Exchange: ['ExchangeHistory'],
          },
        }),
        fetchBalance: vi.fn().mockResolvedValue([]),
      } as any);
      vi.spyOn(ExchangeManager, 'disconnectProvider').mockResolvedValue(undefined);
      const invalidateUserSpy = vi.spyOn(ExchangeManager, 'invalidateUserProvider');

      // Step 2: New encrypted credentials are persisted in D1 via /api/exchange/connect
      const app = createAuthedApp();
      const res = await app.request(
        '/api/exchange/connect',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchangeName: 'bybit',
            apiKey: 'NEW_FRESH_KEY_999',
            apiSecret: 'NEW_FRESH_SEC_999',
            environment: 'demo',
          }),
        },
        botEnv
      );

      expect(reloadAttempts).toBe(2);
      expect(res.status).toBe(503);
      const data = await res.json<any>();
      expect(data.success).toBe(false);
      expect(data.code).toBe('CREDENTIAL_CACHE_INVALIDATION_FAILED');

      // Step 4: The existing Durable Object still has its previous in-memory credentials before the next background cycle
      expect((liveBot as any).cachedCredentials?.apiKey).toBe('OLD_STALE_KEY_001');

      // Step 5: Background WAL reconciliation + open-position monitoring run via alarm()
      const usedApiKeysInBackground: string[] = [];
      vi.spyOn(ExchangeManager, 'getProvider').mockImplementation(async (_name, cfg) => {
        usedApiKeysInBackground.push(cfg.apiKey);
        return {
          fetchPositions: vi.fn().mockResolvedValue([
            { symbol: 'BTC/USDT', side: 'long', size: new BigNumber(0.001) },
          ]),
          fetchOpenOrders: vi.fn().mockResolvedValue([]),
          fetchTicker: vi.fn().mockResolvedValue({ last: new BigNumber(60200) }),
        } as any;
      });

      await liveBot.alarm();

      // Prove that step 5 NEVER used OLD_STALE_KEY_001; it detected the D1 fingerprint mismatch,
      // invalidated the old provider, decrypted NEW_FRESH_KEY_999, and used NEW_FRESH_KEY_999!
      expect(usedApiKeysInBackground.length).toBeGreaterThan(0);
      expect(usedApiKeysInBackground).not.toContain('OLD_STALE_KEY_001');
      expect(usedApiKeysInBackground.every((k) => k === 'NEW_FRESH_KEY_999')).toBe(true);
      expect((liveBot as any).cachedCredentials?.apiKey).toBe('NEW_FRESH_KEY_999');
      expect(invalidateUserSpy).toHaveBeenCalledWith(
        'bybit',
        expect.objectContaining({
          apiKey: 'OLD_STALE_KEY_001',
          environment: 'demo',
        })
      );
      // Monitoring alarm remains active and open position is never abandoned
      expect(deleteAlarmSpy).not.toHaveBeenCalled();
      expect(setAlarmSpy).toHaveBeenCalled();
    });
  });

  describe('Finding 3 — Fail-Closed Environment Handling Across All 8 Paths', () => {
    it('1 & 2. Explicit demo, testnet, and mainnet resolve to distinct canonical Bybit endpoints and never alias testnet to demo', async () => {
      const encKey = await encrypt('KEY_123456', TEST_ENC_KEY);
      const encSec = await encrypt('SEC_123456', TEST_ENC_KEY);

      const expectedRestBaseByEnv: Record<'demo' | 'testnet' | 'mainnet', string> = {
        demo: 'https://api-demo.bybit.com',
        testnet: 'https://api-testnet.bybit.com',
        mainnet: 'https://api.bybit.com',
      };

      for (const envMode of ['demo', 'testnet', 'mainnet'] as const) {
        const probeAdapter = new BybitAdapter();
        await probeAdapter.connect({
          apiKey: 'KEY_123456',
          secret: 'SEC_123456',
          environment: envMode,
        });
        expect(probeAdapter.getHost()).toBe(expectedRestBaseByEnv[envMode]);

        const getProviderSpy = vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
          fetchBalance: vi.fn().mockResolvedValue([
            {
              currency: 'USDT',
              free: new BigNumber(500),
              used: new BigNumber(0),
              total: new BigNumber(500),
            },
          ]),
        } as any);

        const mockEnv: Env = {
          DB: {
            prepare: vi.fn(() => ({
              bind: vi.fn(() => ({
                first: vi.fn(async () => ({
                  exchange_name: 'bybit',
                  exchange_environment: envMode,
                  exchange_region: 'india',
                  exchange_connection_status: 'CONNECTED',
                  exchange_api_key_iv: encKey.iv,
                  exchange_api_key_encrypted: encKey.encrypted,
                  exchange_api_key_salt: encKey.salt,
                  exchange_api_secret_iv: encSec.iv,
                  exchange_api_secret_encrypted: encSec.encrypted,
                  exchange_api_secret_salt: encSec.salt,
                })),
              })),
            })),
          } as any,
          ENCRYPTION_KEY: TEST_ENC_KEY,
          JWT_SECRET: 'jwt-secret-12345678901234567890123456789012',
          TRADING_BOTS: {} as any,
        };

        const app = createAuthedApp();
        const statusRes = await app.request('/api/exchange/status', { method: 'GET' }, mockEnv);
        expect(statusRes.status).toBe(200);
        const statusJson = await statusRes.json<any>();
        expect(statusJson.isConnected).toBe(true);
        expect(statusJson.environment).toBe(envMode);

        const balRes = await app.request('/api/exchange/balances', { method: 'GET' }, mockEnv);
        expect(balRes.status).toBe(200);
        const balJson = await balRes.json<any>();
        expect(balJson.success).toBe(true);
        expect(balJson.environment).toBe(envMode);
        expect(getProviderSpy).toHaveBeenCalledWith(
          'bybit',
          expect.objectContaining({ environment: envMode })
        );
      }
    });

    it('3, 4, 5, 6 & 7. Missing, blank, null, or unsupported environment fails closed with INVALID_ENVIRONMENT and makes zero exchange requests', async () => {
      const encKey = await encrypt('KEY_123456', TEST_ENC_KEY);
      const encSec = await encrypt('SEC_123456', TEST_ENC_KEY);
      const invalidEnvs: any[] = [undefined, '', '   ', null, 'staging', 'paper-invalid'];

      for (const badEnv of invalidEnvs) {
        const getProviderSpy = vi.spyOn(ExchangeManager, 'getProvider');
        const createUncachedSpy = vi.spyOn(ExchangeManager, 'createUncachedProvider');

        const mockEnv: Env = {
          DB: {
            prepare: vi.fn(() => ({
              bind: vi.fn(() => ({
                first: vi.fn(async () => ({
                  exchange_name: 'bybit',
                  exchange_environment: badEnv,
                  exchange_region: 'india',
                  exchange_connection_status: 'CONNECTED',
                  exchange_api_key_iv: encKey.iv,
                  exchange_api_key_encrypted: encKey.encrypted,
                  exchange_api_key_salt: encKey.salt,
                  exchange_api_secret_iv: encSec.iv,
                  exchange_api_secret_encrypted: encSec.encrypted,
                  exchange_api_secret_salt: encSec.salt,
                })),
              })),
            })),
          } as any,
          ENCRYPTION_KEY: TEST_ENC_KEY,
          JWT_SECRET: 'jwt-secret-12345678901234567890123456789012',
          TRADING_BOTS: {} as any,
        };

        const app = createAuthedApp();

        // Path 1: Exchange status
        const statusRes = await app.request('/api/exchange/status', { method: 'GET' }, mockEnv);
        expect(statusRes.status).toBe(400);
        expect((await statusRes.json<any>()).code).toBe('INVALID_ENVIRONMENT');

        // Path 2: Exchange balance
        const balRes = await app.request('/api/exchange/balances', { method: 'GET' }, mockEnv);
        expect(balRes.status).toBe(400);
        expect((await balRes.json<any>()).code).toBe('INVALID_ENVIRONMENT');

        // Path 3: Market candidates
        const candRes = await app.request('/api/market/candidates?budget=10', { method: 'GET' }, mockEnv);
        expect(candRes.status).toBe(400);
        expect((await candRes.json<any>()).code).toBe('INVALID_ENVIRONMENT');

        // Path 4: Technical analysis
        const taRes = await app.request(
          '/api/market/technical-analysis',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: 'BTC/USDT', strategy: 'ScalperV2' }),
          },
          mockEnv
        );
        expect(taRes.status).toBe(400);
        expect((await taRes.json<any>()).code).toBe('INVALID_ENVIRONMENT');

        // Validate / Connect endpoints
        const valRes = await app.request(
          '/api/exchange/validate',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              exchangeName: 'bybit',
              apiKey: 'KEY_123456',
              apiSecret: 'SEC_123456',
              environment: badEnv,
            }),
          },
          mockEnv
        );
        expect(valRes.status).toBe(400);
        expect((await valRes.json<any>()).code).toBe('INVALID_ENVIRONMENT');

        // Path 5, 6, 7, 8: DO Bot Activation, Trade Execution, Background Credential Retrieval, and DO Candidate Approval
        const { state } = createMockDurableObjectState({
          userId: TEST_USER_ID,
          candidateApprovalGeneration: 1,
          approvedCandidateRecord: {
            approvalState: 'FINAL_APPROVED',
            approvalGeneration: 1,
            userId: TEST_USER_ID,
            exchangeName: 'bybit',
            environment: 'demo',
            budgetUsdt: 10,
            approvedSymbols: ['BTC/USDT'],
            expiresAt: Date.now() + 300_000,
          },
          alerts: [
            {
              id: 'alert-env-test',
              symbol: 'BTC/USDT',
              side: 'BUY',
              entryPrice: 60000,
              signalPrice: 60000,
              stopLoss: 59000,
              takeProfit: 62000,
              positionSize: 10,
              quantity: 0.001,
              status: 'pending',
              source: 'MANUAL',
              timestamp: new Date().toISOString(),
            },
          ],
        });
        const doBot = new TradingBot(state, mockEnv);

        // Path 5: Bot activation fails closed with INVALID_ENVIRONMENT
        const actRes = await doBot.fetch(
          new Request('http://bot/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: TEST_USER_ID,
              symbols: ['BTC/USDT'],
              strategy: 'ScalperV2',
              positionSize: 10,
              approvalGeneration: 1,
            }),
          })
        );
        expect(actRes.status).toBe(400);
        expect((await actRes.json<any>()).code).toBe('INVALID_ENVIRONMENT');

        // Path 6: Trade execution fails closed with INVALID_ENVIRONMENT
        const execRes = await doBot.fetch(
          new Request('http://bot/execute-trade', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alertId: 'alert-env-test' }),
          })
        );
        expect(execRes.status).toBe(400);
        expect((await execRes.json<any>()).code).toBe('INVALID_ENVIRONMENT');

        // Path 7: Background credential retrieval fails closed (returns null)
        const bgCreds = await (doBot as any).getOrLoadExchangeCredentials(TEST_USER_ID);
        expect(bgCreds).toBeNull();

        // Path 8: DO candidate approval commit fails closed when record.environment is invalid
        const commitRes = await doBot.fetch(
          new Request('http://bot/commit-final-approved-candidates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              record: {
                approvalState: 'FINAL_APPROVED',
                approvalGeneration: 1,
                userId: TEST_USER_ID,
                exchangeName: 'bybit',
                environment: badEnv,
                budgetUsdt: 10,
                approvedSymbols: ['BTC/USDT'],
                expiresAt: Date.now() + 300_000,
              },
            }),
          })
        );
        expect(commitRes.status).toBe(400);
        expect((await commitRes.json<any>()).code).toBe('INVALID_ENVIRONMENT');

        // Zero outbound exchange provider connections were created across all failed environment validations
        expect(getProviderSpy).not.toHaveBeenCalled();
        expect(createUncachedSpy).not.toHaveBeenCalled();
      }
    });
  });

  describe('Finding 4 — Withdrawal Permission Least-Privilege Enforcement in Validate & Connect Routes', () => {
    it('4, 5 & 6. Rejects keys with withdrawal enabled or unverifiable permissions with non-retryable clear errors', async () => {
      const mockEnv: Env = {
        DB: {
          prepare: vi.fn(() => ({
            bind: vi.fn(() => ({
              first: vi.fn(async () => null),
              run: vi.fn(async () => ({ success: true })),
            })),
          })),
        } as any,
        ENCRYPTION_KEY: TEST_ENC_KEY,
        JWT_SECRET: 'jwt-secret-12345678901234567890123456789012',
        TRADING_BOTS: {} as any,
      };

      // Case A: Withdrawal permission enabled -> WITHDRAWAL_PERMISSION_FORBIDDEN
      vi.spyOn(ExchangeManager, 'createUncachedProvider').mockResolvedValue({
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        checkApiKeyPermissions: vi.fn().mockResolvedValue({
          isValid: true,
          readOnly: false,
          hasTradingPermission: true,
          permissions: {
            ContractTrade: ['Order', 'Position'],
            Wallet: ['AccountTransfer', 'Withdraw'],
          },
        }),
        fetchBalance: vi.fn().mockResolvedValue([]),
      } as any);

      const app = createAuthedApp();
      const valWithdrawRes = await app.request(
        '/api/exchange/validate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchangeName: 'bybit',
            apiKey: 'WITHDRAW_KEY_123',
            apiSecret: 'WITHDRAW_SEC_123',
            environment: 'mainnet',
          }),
        },
        mockEnv
      );
      expect(valWithdrawRes.status).toBe(400);
      const adapterInstance = new BybitAdapter();
      const valWithdrawJson = await valWithdrawRes.json<any>();
      expect(valWithdrawJson.success).toBe(false);
      expect(valWithdrawJson.code).toBe('WITHDRAWAL_PERMISSION_FORBIDDEN');
      expect((adapterInstance as any).isTerminalExchangeError(new UnifiedError(valWithdrawJson.message, valWithdrawJson.code))).toBe(true);

      const connWithdrawRes = await app.request(
        '/api/exchange/connect',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchangeName: 'bybit',
            apiKey: 'WITHDRAW_KEY_123',
            apiSecret: 'WITHDRAW_SEC_123',
            environment: 'mainnet',
          }),
        },
        mockEnv
      );
      expect(connWithdrawRes.status).toBe(400);
      const connWithdrawJson = await connWithdrawRes.json<any>();
      expect(connWithdrawJson.success).toBe(false);
      expect(connWithdrawJson.code).toBe('WITHDRAWAL_PERMISSION_FORBIDDEN');

      // Case B: Unrecognized/empty permissions -> PERMISSION_VERIFICATION_FAILED
      vi.spyOn(ExchangeManager, 'createUncachedProvider').mockResolvedValue({
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        checkApiKeyPermissions: vi.fn().mockResolvedValue({
          isValid: true,
          readOnly: false,
          hasTradingPermission: true,
          permissions: {},
        }),
        fetchBalance: vi.fn().mockResolvedValue([]),
      } as any);

      const valEmptyPermRes = await app.request(
        '/api/exchange/validate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchangeName: 'bybit',
            apiKey: 'UNKNOWN_PERM_KEY',
            apiSecret: 'UNKNOWN_PERM_SEC',
            environment: 'demo',
          }),
        },
        mockEnv
      );
      expect(valEmptyPermRes.status).toBe(400);
      const valEmptyPermJson = await valEmptyPermRes.json<any>();
      expect(valEmptyPermJson.success).toBe(false);
      expect(valEmptyPermJson.code).toBe('PERMISSION_VERIFICATION_FAILED');
      expect((adapterInstance as any).isTerminalExchangeError(new UnifiedError(valEmptyPermJson.message, valEmptyPermJson.code))).toBe(true);

      // Case C: Official Bybit /v5/user/query-api example with Wallet: ["AccountTransfer", "SubMemberTransfer"] and Exchange: ["ExchangeHistory"] is accepted
      vi.spyOn(ExchangeManager, 'createUncachedProvider').mockResolvedValue({
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        checkApiKeyPermissions: vi.fn().mockResolvedValue({
          isValid: true,
          readOnly: false,
          hasTradingPermission: true,
          hasWithdrawPermission: false,
          withdrawalVerificationStatus: 'DISABLED',
          permissions: {
            ContractTrade: ['Order', 'Position'],
            Spot: ['SpotTrade'],
            Wallet: ['AccountTransfer', 'SubMemberTransfer'],
            Options: ['OptionsTrade'],
            Derivatives: [],
            CopyTrading: [],
            BlockTrade: [],
            Exchange: ['ExchangeHistory'],
            NFT: [],
            Affiliate: [],
          },
        }),
        fetchBalance: vi.fn().mockResolvedValue([]),
      } as any);

      const valOfficialRes = await app.request(
        '/api/exchange/validate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchangeName: 'bybit',
            apiKey: 'OFFICIAL_BYBIT_KEY_123',
            apiSecret: 'OFFICIAL_BYBIT_SEC_123',
            environment: 'demo',
          }),
        },
        mockEnv
      );
      expect(valOfficialRes.status).toBe(200);
      const valOfficialJson = await valOfficialRes.json<any>();
      expect(valOfficialJson.success).toBe(true);
    });
  });
});
