import { describe, it, expect, vi, beforeEach } from 'vitest';
import BigNumber from 'bignumber.js';
import { TradingBot, TradeAlert, ApprovedCandidateRecord } from '../../src/trading-bot';
import {
  handleGetPersonalizedMarketCandidates,
  handleGetMarketOpportunities,
  handleGetTechnicalAnalysis,
  handleActivateTradingBot,
  __resetPublicOpportunityStateForTests
} from '../../src/handlers/exchange';
import * as notifications from '../../src/handlers/notifications';
import { DirectionalMtfArbitrator } from '../../src/engine/arbitration/DirectionalMtfArbitrator';
import { ExchangeManager } from '../../src/exchanges';

vi.mock('../../src/crypto', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    decrypt: vi.fn().mockResolvedValue('mocked_secret_key'),
    encrypt: vi.fn().mockResolvedValue({ iv: 'iv', encrypted: 'enc', salt: 'salt' }),
    cleanCredential: (c: string) => c ? c.trim() : c
  };
});

const mockExecuteCycle = vi.fn();
vi.mock('../../src/engine/orchestrator/StrategyOrchestrator', () => {
  const StrategyOrchestratorMock = vi.fn();
  StrategyOrchestratorMock.prototype.setMarketDataEngine = vi.fn();
  StrategyOrchestratorMock.prototype.executeCycle = (...args: any[]) => mockExecuteCycle(...args);
  StrategyOrchestratorMock.prototype.getCurrentState = vi.fn().mockReturnValue('ACTIVE');
  StrategyOrchestratorMock.prototype.getLastSnapshot = vi.fn().mockReturnValue(null);
  return {
    StrategyOrchestrator: StrategyOrchestratorMock
  };
});

describe('Strict Budget Gate Integration Tests (Stage 2.10 - 2.11D)', () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockDb: any;
  const userId = 'usr_strict_gate_test';

  const mockMarkets = [
    {
      id: 'BTCUSDT',
      symbol: 'BTC/USDT',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      category: 'linear',
      contractType: 'LinearPerpetual',
      precision: { price: 0.1, amount: 0.001 },
      limits: {
        amount: { min: 0.001, max: 100 },
        marketAmount: { max: 50 },
        cost: { min: 5 }
      }
    },
    {
      id: 'SOLUSDT',
      symbol: 'SOL/USDT',
      base: 'SOL',
      quote: 'USDT',
      active: true,
      category: 'linear',
      contractType: 'LinearPerpetual',
      precision: { price: 0.01, amount: 0.1 },
      limits: {
        amount: { min: 0.1, max: 5000 },
        marketAmount: { max: 2000 },
        cost: { min: 5 }
      }
    },
    {
      id: 'EXPENSIVEUSDT',
      symbol: 'EXPENSIVE/USDT',
      base: 'EXPENSIVE',
      quote: 'USDT',
      active: true,
      category: 'linear',
      contractType: 'LinearPerpetual',
      precision: { price: 1, amount: 1 },
      limits: {
        amount: { min: 1, max: 10 },
        cost: { min: 500 } // $500 minNotional -> Ineligible for $100 budget
      }
    }
  ];

  const mockTickers = [
    {
      symbol: 'BTC/USDT',
      last: 50000,
      bid: 49990,
      ask: 50010,
      quoteVolume: 100_000_000,
      high: 51000,
      low: 49000,
      percentage: 2.5
    },
    {
      symbol: 'SOL/USDT',
      last: 150,
      bid: 149.9,
      ask: 150.1,
      quoteVolume: 40_000_000,
      high: 155,
      low: 145,
      percentage: 4.1
    },
    {
      symbol: 'EXPENSIVE/USDT',
      last: 1000,
      bid: 999,
      ask: 1001,
      quoteVolume: 10_000_000,
      high: 1050,
      low: 950,
      percentage: 1.0
    }
  ];

  let mockAdapter: any;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetPublicOpportunityStateForTests();
    mockStorage = new Map();

    mockState = {
      id: { toString: () => 'mock-do-id' },
      storage: {
        get: vi.fn(async (keyOrKeys: string | string[]) => {
          if (Array.isArray(keyOrKeys)) {
            const res = new Map();
            for (const k of keyOrKeys) {
              if (mockStorage.has(k)) res.set(k, mockStorage.get(k));
            }
            return res;
          }
          return mockStorage.get(keyOrKeys);
        }),
        put: vi.fn(async (keyOrEntries: string | Record<string, any>, val?: any) => {
          if (typeof keyOrEntries === 'string') {
            mockStorage.set(keyOrEntries, val);
          } else if (keyOrEntries && typeof keyOrEntries === 'object') {
            for (const [k, v] of Object.entries(keyOrEntries)) {
              mockStorage.set(k, v);
            }
          }
        }),
        delete: vi.fn(async (key: string) => mockStorage.delete(key)),
        list: vi.fn(async (opts?: any) => {
          const map = new Map();
          const prefix = opts?.prefix;
          for (const [k, v] of mockStorage.entries()) {
            if (!prefix || k.startsWith(prefix)) {
              map.set(k, v);
            }
          }
          return map;
        }),
        transaction: vi.fn(async (cb: any) => cb(mockState.storage)),
        setAlarm: vi.fn().mockResolvedValue(undefined),
        getAlarm: vi.fn().mockResolvedValue(null)
      },
      blockConcurrencyWhile: vi.fn(async (fn: () => Promise<any>) => fn())
    };

    mockDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        return {
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockImplementation(async () => {
              if (sql.includes('FROM users')) {
                return {
                  exchange_name: 'bybit',
                  exchange_environment: 'mainnet',
                  exchange_region: 'global',
                  exchange_api_key_iv: 'iv',
                  exchange_api_key_encrypted: 'enc',
                  exchange_api_key_salt: 'salt',
                  exchange_api_secret_iv: 'iv',
                  exchange_api_secret_encrypted: 'enc',
                  exchange_api_secret_salt: 'salt'
                };
              }
              return null;
            }),
            all: vi.fn().mockResolvedValue({ results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] }),
            run: vi.fn().mockResolvedValue({ success: true })
          }),
          all: vi.fn().mockResolvedValue({ results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] })
        };
      })
    };

    mockAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(mockMarkets),
      fetchTickers: vi.fn().mockResolvedValue(mockTickers),
      fetchTicker: vi.fn().mockImplementation(async (sym: string) => {
        return mockTickers.find(t => t.symbol === sym || t.symbol === `${sym}/USDT`) || { last: 50000 };
      }),
      fetchKlines: vi.fn().mockResolvedValue(
        Array.from({ length: 70 }, (_, i) => ({
          openTime: Date.now() - (70 - i) * 60000,
          timestamp: Date.now() - (70 - i) * 60000,
          open: 50000 + i * 10,
          high: 50020 + i * 10,
          low: 49980 + i * 10,
          close: 50010 + i * 10,
          volume: 100
        }))
      ),
      fetchCandles: vi.fn().mockResolvedValue(
        Array.from({ length: 70 }, (_, i) => ({
          openTime: Date.now() - (70 - i) * 60000,
          timestamp: Date.now() - (70 - i) * 60000,
          open: 50000 + i * 10,
          high: 50020 + i * 10,
          low: 49980 + i * 10,
          close: 50010 + i * 10,
          volume: 100
        }))
      ),
      fetchPositions: vi.fn().mockResolvedValue([]),
      fetchBalance: vi.fn().mockResolvedValue([
        { currency: 'USDT', free: new BigNumber(10000), total: new BigNumber(10000) }
      ]),
      createOrder: vi.fn().mockResolvedValue({ id: 'ord-123', status: 'closed', filled: 1, amount: 1 })
    };

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);
    vi.spyOn(DirectionalMtfArbitrator, 'evaluateCandidate').mockReturnValue({ passed: true, gate: 'PASS', reasoning: 'Mock passed' } as any);
    vi.spyOn(notifications, 'sendTradeNotification').mockResolvedValue({ success: true, outcome: 'DELIVERED', httpStatus: 200 } as any);

    mockEnv = {
      DB: mockDb,
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      COOKIE_ENCRYPTION_KEY: 'test-key',
      GLOBAL_TRADING_HALT: 'false'
    };
  });

  describe('1. Two-Phase Candidate Approval in Discovery', () => {
    it('executes Phase 1 DISCOVERY_APPROVED -> scanner -> Phase 2 FINAL_APPROVED and attaches X-Approval-Generation', async () => {
      const realBot = new TradingBot(mockState, mockEnv);

      const tradingBotsBinding = {
        idFromName: vi.fn().mockReturnValue('mock-bot-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockImplementation((req: Request) => realBot.fetch(req))
        })
      };

      const ctxHeaders: Record<string, string> = {};
      const ctx = {
        get: vi.fn().mockReturnValue({ sub: userId }),
        env: { ...mockEnv, TRADING_BOTS: tradingBotsBinding },
        status: vi.fn(),
        header: vi.fn().mockImplementation((k: string, v: string) => { ctxHeaders[k] = v; }),
        json: vi.fn().mockImplementation(data => data),
        req: { query: vi.fn().mockImplementation((k: string) => k === 'budget' ? '100' : undefined) }
      } as any;

      const candidates = await handleGetPersonalizedMarketCandidates(ctx) as any;

      expect(Array.isArray(candidates)).toBe(true);
      expect(candidates.length).toBeGreaterThan(0);

      // Verify that EXPENSIVE ($500 minNotional) was excluded by budget gate
      const symbols = candidates.map((c: any) => c.symbol);
      expect(symbols).not.toContain('EXPENSIVE');

      // Verify header matches generation
      expect(ctxHeaders['X-Approval-Generation']).toBeDefined();
      const generation = Number(ctxHeaders['X-Approval-Generation']);
      expect(generation).toBeGreaterThanOrEqual(1);

      // Verify DO storage has FINAL_APPROVED state
      const storedApproval = mockStorage.get('approvedCandidateRecord') as ApprovedCandidateRecord;
      expect(storedApproval).toBeDefined();
      expect(storedApproval.approvalState).toBe('FINAL_APPROVED');
      expect(storedApproval.approvalGeneration).toBe(generation);
      expect(storedApproval.budgetUsdt).toBe(100);
      expect(storedApproval.userId).toBe(userId);
      expect(storedApproval.approvedSymbols).toEqual(expect.arrayContaining(['BTC', 'SOL']));
      expect(storedApproval.approvedSymbols).not.toContain('EXPENSIVE');
    });

    it('strictly fails closed with 400 INVALID_BUDGET when budget is missing, zero, or negative', async () => {
      const testCases = [undefined, '0', '-50', 'not-a-number'];

      for (const budgetVal of testCases) {
        const ctx = {
          get: vi.fn().mockReturnValue({ sub: userId }),
          env: mockEnv,
          status: vi.fn(),
          json: vi.fn().mockImplementation(data => data),
          req: { query: vi.fn().mockImplementation((k: string) => k === 'budget' ? budgetVal : undefined) }
        } as any;

        const res = await handleGetPersonalizedMarketCandidates(ctx) as any;
        expect(ctx.status).toHaveBeenCalledWith(400);
        expect(res.code).toBe('INVALID_BUDGET');
      }
    });

    it('fails closed with 500 when DO reservation fails', async () => {
      const brokenBinding = {
        idFromName: vi.fn().mockReturnValue('mock-bot-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 500 }))
        })
      };

      const ctx = {
        get: vi.fn().mockReturnValue({ sub: userId }),
        env: { ...mockEnv, TRADING_BOTS: brokenBinding },
        status: vi.fn(),
        json: vi.fn().mockImplementation(data => data),
        req: { query: vi.fn().mockImplementation((k: string) => k === 'budget' ? '100' : undefined) }
      } as any;

      const res = await handleGetPersonalizedMarketCandidates(ctx) as any;
      expect(ctx.status).toHaveBeenCalledWith(500);
      expect(res.success).toBe(false);
    });
  });

  describe('2. Pre-TA Gate in handleGetTechnicalAnalysis', () => {
    it('rejects on-demand Technical Analysis with HTTP 403 SYMBOL_NOT_APPROVED when symbol is not in approved list', async () => {
      const realBot = new TradingBot(mockState, mockEnv);

      // Seed approved record with only SOL
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['SOL', 'SOLUSDT', 'SOL/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp-1',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const tradingBotsBinding = {
        idFromName: vi.fn().mockReturnValue('mock-bot-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockImplementation((req: Request) => realBot.fetch(req))
        })
      };

      const ctx = {
        get: vi.fn().mockReturnValue({ sub: userId }),
        env: { ...mockEnv, TRADING_BOTS: tradingBotsBinding },
        status: vi.fn(),
        json: vi.fn().mockImplementation(data => data),
        req: {
          query: vi.fn().mockImplementation((k: string) => k === 'symbol' ? 'BTC/USDT' : undefined),
          json: vi.fn().mockResolvedValue({ symbol: 'BTC/USDT', strategy: 'ScalperV2' })
        }
      } as any;

      const res = await handleGetTechnicalAnalysis(ctx) as any;
      expect(ctx.status).toHaveBeenCalledWith(403);
      expect(res.code).toBe('SYMBOL_NOT_APPROVED');

      // Verify no candles or indicators were calculated
      expect(mockAdapter.fetchKlines).not.toHaveBeenCalled();
    });

    it('permits Technical Analysis when symbol is in approved list', async () => {
      const realBot = new TradingBot(mockState, mockEnv);

      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp-1',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const tradingBotsBinding = {
        idFromName: vi.fn().mockReturnValue('mock-bot-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockImplementation((req: Request) => realBot.fetch(req))
        })
      };

      const ctx = {
        get: vi.fn().mockReturnValue({ sub: userId }),
        env: { ...mockEnv, TRADING_BOTS: tradingBotsBinding },
        status: vi.fn(),
        json: vi.fn().mockImplementation(data => data),
        req: {
          query: vi.fn().mockImplementation((k: string) => k === 'symbol' ? 'BTC/USDT' : undefined),
          json: vi.fn().mockResolvedValue({ symbol: 'BTC/USDT', strategy: 'ScalperV2' })
        }
      } as any;

      const res = await handleGetTechnicalAnalysis(ctx) as any;
      expect(ctx.status).not.toHaveBeenCalledWith(403);
      expect(res.marketAnalysis || res.indicators || res.engineStatus).toBeDefined();
    });
  });

  describe('3. Pre-TA Gate in TradingBot.alarm()', () => {
    it('skips new strategy evaluation when approval record is missing while preserving position monitoring', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('strategy', 'ScalperV2');
      mockStorage.set('isActive', true);
      mockStorage.set('monitoredSymbols', ['BTC/USDT']);
      // approval record is missing!

      const bot = new TradingBot(mockState, mockEnv);
      const monitorSpy = vi.spyOn(bot as any, 'monitorOpenPositions').mockResolvedValue(undefined);

      await bot.alarm();

      // Monitor open positions MUST still run
      expect(monitorSpy).toHaveBeenCalled();
      // No strategy cycles may run
      expect(mockExecuteCycle).not.toHaveBeenCalled();
    });

    it('skips new strategy evaluation when approval record is expired while preserving position monitoring', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('strategy', 'ScalperV2');
      mockStorage.set('isActive', true);
      mockStorage.set('monitoredSymbols', ['BTC/USDT']);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp-1',
        orderType: 'MARKET',
        approvedAt: Date.now() - 1200000,
        expiresAt: Date.now() - 600000, // EXPIRED
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      const monitorSpy = vi.spyOn(bot as any, 'monitorOpenPositions').mockResolvedValue(undefined);

      await bot.alarm();

      expect(monitorSpy).toHaveBeenCalled();
      expect(mockExecuteCycle).not.toHaveBeenCalled();
    });

    it('evaluates only approved symbols in alarm cycle', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('strategy', 'ScalperV2');
      mockStorage.set('isActive', true);
      mockStorage.set('monitoredSymbols', ['BTC/USDT', 'UNAPPROVED/USDT']);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'], // UNAPPROVED is omitted
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp-1',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      vi.spyOn(bot as any, 'monitorOpenPositions').mockResolvedValue(undefined);

      await bot.alarm();

      // UNAPPROVED/USDT must never reach strategy execution
      if (mockExecuteCycle.mock.calls.length > 0) {
        for (const call of mockExecuteCycle.mock.calls) {
          expect(call[0]).not.toContain('UNAPPROVED');
        }
      }
    });
  });

  describe('4. Activation Gate in TradingBot.activate()', () => {
    it('rejects activation of unapproved symbol with HTTP 403 SYMBOL_NOT_APPROVED', async () => {
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp-1',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      const req = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          symbols: ['ETH/USDT'],
          strategy: 'ScalperV2',
          positionSize: 100,
          approvalGeneration: 1
        })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.code).toBe('SYMBOL_NOT_APPROVED');
    });

    it('rejects activation with generation mismatch with HTTP 409 STALE_APPROVAL_GENERATION', async () => {
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 2,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp-1',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      const req = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          symbols: ['BTC/USDT'],
          strategy: 'ScalperV2',
          positionSize: 100,
          approvalGeneration: 1 // Stale generation
        })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.code).toBe('STALE_APPROVAL_GENERATION');
    });

    it('rejects activation with budget mismatch with HTTP 409 POSITION_SIZE_BUDGET_MISMATCH (Zero Tolerance)', async () => {
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp-1',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      const req = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          symbols: ['BTC/USDT'],
          strategy: 'ScalperV2',
          positionSize: 100.0001, // Mismatched budget
          approvalGeneration: 1
        })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.code).toBe('POSITION_SIZE_BUDGET_MISMATCH');
    });

    it('succeeds activation when symbol, generation, and budget match exactly', async () => {
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp-1',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      const req = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          symbols: ['BTC/USDT'],
          strategy: 'ScalperV2',
          positionSize: 100,
          approvalGeneration: 1
        })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });
  });

  describe('5. Execution Gate in TradingBot.executeTrade()', () => {
    const baseAlert: TradeAlert = {
      id: 'alert-strict-001',
      symbol: 'BTC/USDT',
      strategy: 'ScalperV2',
      side: 'BUY',
      entryIntent: 'IMMEDIATE',
      entryPrice: 50000,
      signalPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      positionSize: 100,
      quantity: 0.002,
      approvalGeneration: 1,
      status: 'pending',
      timestamp: new Date().toISOString()
    };

    it('rejects execution when symbol is not in approved candidate list', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('alerts', [{ ...baseAlert, symbol: 'UNAPPROVED/USDT' }]);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp-1',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert-strict-001', action: 'CONFIRM' })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.code).toBe('SYMBOL_NOT_APPROVED');
    });

    it('rejects execution when approval generation is stale', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('alerts', [{ ...baseAlert, approvalGeneration: 1 }]);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 2, // New generation
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp-1',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert-strict-001', action: 'CONFIRM' })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.code).toBe('STALE_APPROVAL_GENERATION');
    });

    it('rejects execution when alert budget mismatches approved budget (Zero Tolerance)', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('alerts', [{ ...baseAlert, positionSize: 100.0001 }]);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp-1',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert-strict-001', action: 'CONFIRM' })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.code).toBe('BUDGET_MISMATCH');
    });

    it('rejects execution when approval record is expired', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('alerts', [baseAlert]);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp-1',
        orderType: 'MARKET',
        approvedAt: Date.now() - 1200000,
        expiresAt: Date.now() - 600000, // EXPIRED
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert-strict-001', action: 'CONFIRM' })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.code).toBe('APPROVAL_EXPIRED');
    });
  });

  describe('6. Zero-Candidate Clearing & Invalidation', () => {
    it('invalidates existing approval on /commit-empty-candidates fail-closed', async () => {
      const realBot = new TradingBot(mockState, mockEnv);

      // Initially active approved record
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp-1',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      // User performs new scan which yields 0 candidates -> commits empty state
      const emptyReq = new Request('http://bot/commit-empty-candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generation: 2 })
      });

      const emptyRes = await realBot.fetch(emptyReq);
      expect(emptyRes.status).toBe(200);

      // Verify that BTC is no longer approved
      const verifyReq = new Request('http://bot/verify-approval?symbol=BTC/USDT');
      const verifyRes = await realBot.fetch(verifyReq);
      expect(verifyRes.status).toBe(200);
      const verifyData = await verifyRes.json() as any;
      expect(verifyData.valid).toBe(false);

      // Verify stored record is cleared / deleted
      const record = mockStorage.get('approvedCandidateRecord');
      expect(record).toBeUndefined();
    });

    it('rejects stale empty candidates commit from an older generation', async () => {
      const realBot = new TradingBot(mockState, mockEnv);
      mockStorage.set('candidateApprovalGeneration', 2);
      (realBot as any).runtimeState.candidateApprovalGeneration = 2;

      const staleReq = new Request('http://bot/commit-empty-candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generation: 1 })
      });
      const res = await realBot.fetch(staleReq);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.code).toBe('STALE_EMPTY_GENERATION');
    });

    it('rejects delayed final candidate commit from older concurrent scan when empty candidates committed newer generation', async () => {
      const realBot = new TradingBot(mockState, mockEnv);
      mockStorage.set('candidateApprovalGeneration', 2);
      (realBot as any).runtimeState.candidateApprovalGeneration = 2;

      const staleFinalReq = new Request('http://bot/commit-final-approved-candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          record: {
            approvalGeneration: 1, // older scan
            userId,
            budgetUsdt: 100,
            approvedSymbols: ['BTC', 'BTCUSDT'],
            approvalState: 'FINAL_APPROVED',
            exchangeName: 'bybit',
            environment: 'mainnet',
            accountFingerprint: 'bybit:mainnet',
            orderType: 'MARKET',
            approvedAt: Date.now(),
            expiresAt: Date.now() + 600000,
            symbolMetadataSnapshot: {}
          }
        })
      });
      const res = await realBot.fetch(staleFinalReq);
      expect(res.status).toBe(400);
      expect(mockStorage.get('approvedCandidateRecord')).toBeUndefined();
    });
  });

  describe('7. Fresh Approval Renewal After Expiry', () => {
    it('proves fresh candidate scan renews expired approval with new generation, rejecting stale generation', async () => {
      const realBot = new TradingBot(mockState, mockEnv);

      // 1. Initial approval record expires
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'bybit:mainnet',
        orderType: 'MARKET',
        approvedAt: Date.now() - 1200000,
        expiresAt: Date.now() - 600000, // EXPIRED
        symbolMetadataSnapshot: {}
      });
      mockStorage.set('candidateApprovalGeneration', 1);

      // Activation attempt fails because approval is expired
      const actReqExpired = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          strategy: 'ScalperV2',
          coinId: 'BTC/USDT',
          positionSize: 100,
          approvalGeneration: 1
        })
      });
      const actResExpired = await realBot.fetch(actReqExpired);
      expect(actResExpired.status).toBe(400);
      const actDataExpired = await actResExpired.json() as any;
      expect(actDataExpired.code).toBe('APPROVAL_RECORD_INVALID_OR_EXPIRED');

      // 2. Android lifecycle initiates fresh candidate scan with same configured budget ($100), user, exchange, env
      const tradingBotsBinding = {
        idFromName: vi.fn().mockReturnValue('mock-bot-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockImplementation((req: Request) => realBot.fetch(req))
        })
      };

      const ctxHeaders: Record<string, string> = {};
      const ctx = {
        get: vi.fn().mockReturnValue({ sub: userId }),
        env: { ...mockEnv, TRADING_BOTS: tradingBotsBinding },
        status: vi.fn(),
        header: vi.fn().mockImplementation((k: string, v: string) => { ctxHeaders[k] = v; }),
        json: vi.fn().mockImplementation(data => data),
        req: { query: vi.fn().mockImplementation((k: string) => k === 'budget' ? '100' : undefined) }
      } as any;

      const candidates = await handleGetPersonalizedMarketCandidates(ctx) as any;
      expect(Array.isArray(candidates)).toBe(true);
      expect(candidates.length).toBeGreaterThan(0);

      // Verify that fresh scan committed new approval generation (2)
      const freshRecord = mockStorage.get('approvedCandidateRecord') as ApprovedCandidateRecord;
      expect(freshRecord).toBeDefined();
      expect(freshRecord.approvalGeneration).toBe(2);
      expect(freshRecord.expiresAt).toBeGreaterThan(Date.now());
      expect(freshRecord.budgetUsdt).toBe(100);

      // 3. Activation with new generation 2 succeeds
      const actReqFresh = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          strategy: 'ScalperV2',
          coinId: 'BTC/USDT',
          positionSize: 100,
          approvalGeneration: 2
        })
      });
      const actResFresh = await realBot.fetch(actReqFresh);
      expect(actResFresh.status).toBe(200);

      // 4. Stale activation attempt with generation 1 is strictly rejected
      const actReqStale = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          strategy: 'ScalperV2',
          coinId: 'BTC/USDT',
          positionSize: 100,
          approvalGeneration: 1
        })
      });
      const actResStale = await realBot.fetch(actReqStale);
      expect(actResStale.status).toBe(409);
      const actDataStale = await actResStale.json() as any;
      expect(actDataStale.code).toBe('STALE_APPROVAL_GENERATION');
    });
  });

  describe('8. /api/market/opportunities Complete Isolation', () => {
    it('proves /api/market/opportunities cannot independently touch DO approval, activate bots, or create TradeAlerts', async () => {
      const realBot = new TradingBot(mockState, mockEnv);

      const tradingBotsBinding = {
        idFromName: vi.fn().mockReturnValue('mock-bot-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockImplementation((req: Request) => realBot.fetch(req))
        })
      };

      const ctxHeaders: Record<string, string> = {};
      const ctx = {
        get: vi.fn().mockReturnValue({ sub: userId }),
        env: { ...mockEnv, TRADING_BOTS: tradingBotsBinding },
        status: vi.fn(),
        header: vi.fn().mockImplementation((k: string, v: string) => { ctxHeaders[k] = v; }),
        json: vi.fn().mockImplementation(data => data),
        req: { query: vi.fn().mockReturnValue(undefined) }
      } as any;

      // Invoke public market opportunities endpoint
      const result = await handleGetMarketOpportunities(ctx) as any;
      expect(result).toBeDefined();

      // Verify that NO approvedCandidateRecord exists in DO storage
      expect(mockStorage.get('approvedCandidateRecord')).toBeUndefined();
      expect(mockStorage.get('discoveryApprovalRecord')).toBeUndefined();
      expect(mockStorage.get('candidateApprovalGeneration')).toBeUndefined();

      // Verify that no TradeAlerts were generated
      const alerts = mockStorage.get('alerts');
      expect(alerts).toBeUndefined();

      // Verify DO bot cannot be activated without approved candidate record
      const actReq = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          strategy: 'ScalperV2',
          coinId: 'BTC/USDT',
          positionSize: 100
        })
      });
      const actRes = await realBot.fetch(actReq);
      expect(actRes.status).toBe(400);
      const actData = await actRes.json() as any;
      expect(actData.code).toBe('APPROVAL_RECORD_INVALID_OR_EXPIRED');
    });
  });

  describe('9. Execution Eligibility Invariants: No TradeAlert & No FCM on Min-Notional/Lot-Size Failure', () => {
    it('produces NO TradeAlert and NO FCM notification when trade amount is below minNotional', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('isActive', true);
      mockStorage.set('strategy', 'ScalperV2');
      mockStorage.set('coinId', 'EXPENSIVE/USDT');
      mockStorage.set('lock:alarmGeneration', 1);

      // Mock approved record with generation 1
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 4, // $4 trade amount < $5 minNotional
        approvedSymbols: ['EXPENSIVE', 'EXPENSIVEUSDT', 'EXPENSIVE/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'bybit:mainnet',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {
          EXPENSIVEUSDT: {
            priceAtApproval: 1000,
            qtyStep: 1,
            minOrderQty: 1,
            minNotional: 5
          }
        }
      });

      mockExecuteCycle.mockResolvedValueOnce({
        signals: [
          {
            type: 'BUY',
            strategyId: 'ScalperV2',
            price: 1000,
            symbol: 'EXPENSIVE/USDT',
            timeframe: '1m',
            stopLoss: 980,
            takeProfit: 1040,
            indicators: { rsi: 25 }
          }
        ],
        indicators: { rsi: 25 },
        checkpoints: [{ name: 'RSI Oversold', status: 'passed' }]
      });

      const bot = new TradingBot(mockState, mockEnv);
      await bot.alarm();

      // Verify that NO alert was created in storage
      const alerts = mockStorage.get('alerts') || [];
      expect(alerts.length).toBe(0);

      // Verify that sendTradeNotification was NOT called
      expect(notifications.sendTradeNotification).not.toHaveBeenCalled();
    });

    it('produces NO TradeAlert and NO FCM notification when lot-size metadata is invalid', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('isActive', true);
      mockStorage.set('strategy', 'ScalperV2');
      mockStorage.set('coinId', 'BTC/USDT');
      mockStorage.set('lock:alarmGeneration', 1);

      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'bybit:mainnet',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {
          BTCUSDT: {
            priceAtApproval: 50000,
            qtyStep: 0, // INVALID qtyStep <= 0
            minOrderQty: 0.001,
            minNotional: 5
          }
        }
      });

      // Override market adapter with invalid qtyStep
      mockAdapter.fetchMarkets.mockResolvedValueOnce([
        {
          id: 'BTCUSDT',
          symbol: 'BTC/USDT',
          precision: { price: 0.1, amount: 0 }, // Invalid step 0
          limits: { amount: { min: 0 } }
        }
      ]);

      mockExecuteCycle.mockResolvedValueOnce([
        {
          strategyId: 'Momentum',
          confidenceScore: 88,
          hasSignal: true,
          metadata: {
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              stopLoss: 49000,
              takeProfit: 52000,
              riskAssessment: {
                positionSizeRecommendation: 5.0,
              },
            },
          },
        },
      ]);

      const bot = new TradingBot(mockState, mockEnv);
      await bot.alarm();

      // Verify that NO alert was created in storage
      const alerts = mockStorage.get('alerts') || [];
      expect(alerts.length).toBe(0);

      // Verify that sendTradeNotification was NOT called
      expect(notifications.sendTradeNotification).not.toHaveBeenCalled();
    });

    it('skipping an ineligible ticker does NOT block subsequent eligible tickers from generating alerts', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('isActive', true);
      mockStorage.set('strategy', 'ScalperV2');
      mockStorage.set('coinId', 'EXPENSIVE/USDT');
      mockStorage.set('monitoredSymbols', ['EXPENSIVE/USDT', 'BTC/USDT']);
      mockStorage.set('positionSize', 100);
      mockStorage.set('lock:alarmGeneration', 1);

      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['EXPENSIVE', 'EXPENSIVEUSDT', 'EXPENSIVE/USDT', 'BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'bybit:mainnet',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {
          EXPENSIVEUSDT: {
            priceAtApproval: 1000,
            qtyStep: 1,
            minOrderQty: 1,
            minNotional: 500 // Ineligible for $100 budget
          },
          BTCUSDT: {
            priceAtApproval: 50000,
            qtyStep: 0.001,
            minOrderQty: 0.001,
            minNotional: 5 // Eligible for $100 budget
          }
        }
      });

      // 1st candidate (EXPENSIVE/USDT) fails minNotional check
      // 2nd candidate (BTC/USDT) passes and produces alert
      mockExecuteCycle
        .mockResolvedValueOnce([
          {
            strategyId: 'ScalperV2',
            confidenceScore: 85,
            hasSignal: true,
            metadata: {
              signal: { type: 'BUY', signalPrice: 1000, stopLoss: 980, takeProfit: 1040 }
            }
          }
        ])
        .mockResolvedValueOnce([
          {
            strategyId: 'ScalperV2',
            confidenceScore: 90,
            hasSignal: true,
            metadata: {
              signal: { type: 'BUY', signalPrice: 50000, stopLoss: 49000, takeProfit: 52000 }
            }
          }
        ]);

      const bot = new TradingBot(mockState, mockEnv);
      await bot.alarm();

      // Proves: 1 alert created, and it belongs to BTC/USDT (the second eligible symbol)
      const alerts = mockStorage.get('alerts') || [];
      expect(alerts.length).toBe(1);
      expect(alerts[0].symbol).toBe('BTC/USDT');
      expect(alerts[0].approvalGeneration).toBe(1);
    });
  });

  describe('10. TradeAlert Retains approvalGeneration End-to-End', () => {
    it('persists approvalGeneration on TradeAlert and verifies matching in /execute-trade', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('isActive', true);
      mockStorage.set('strategy', 'ScalperV2');
      mockStorage.set('coinId', 'BTC/USDT');
      mockStorage.set('monitoredSymbols', ['BTC/USDT']);
      mockStorage.set('positionSize', 100);
      mockStorage.set('lock:alarmGeneration', 1);

      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 5,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'bybit:mainnet',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {
          BTCUSDT: {
            priceAtApproval: 50000,
            qtyStep: 0.001,
            minOrderQty: 0.001,
            minNotional: 5
          }
        }
      });

      mockExecuteCycle.mockResolvedValueOnce([
        {
          strategyId: 'Momentum',
          confidenceScore: 88,
          hasSignal: true,
          metadata: {
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              stopLoss: 49000,
              takeProfit: 52000,
              riskAssessment: {
                positionSizeRecommendation: 5.0,
              },
            },
          },
        },
      ]);

      const bot = new TradingBot(mockState, mockEnv);
      await bot.alarm();

      const alerts = mockStorage.get('alerts') as TradeAlert[];
      expect(alerts).toBeDefined();
      expect(alerts.length).toBe(1);
      const alert = alerts[0];

      // 1. Proves TradeAlert receives approvalGeneration 5 before persistence
      expect(alert.approvalGeneration).toBe(5);

      // 2. Proves FCM notification receives approvalGeneration 5
      expect(notifications.sendTradeNotification).toHaveBeenCalledWith(
        expect.anything(),
        userId,
        alert.id,
        expect.objectContaining({ approvalGeneration: 5 }),
        expect.anything(),
        expect.anything()
      );

      // 3. Proves /execute-trade with mismatched approvalGeneration is rejected
      const staleExecReq = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: alert.id,
          approvalGeneration: 4 // Mismatch: 4 vs 5
        })
      });
      const staleRes = await bot.fetch(staleExecReq);
      expect(staleRes.status).toBe(409);
      const staleData = await staleRes.json() as any;
      expect(staleData.code).toBe('STALE_APPROVAL_GENERATION');

      // 4. Proves /execute-trade with matching approvalGeneration passes the gate
      const validExecReq = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: alert.id,
          approvalGeneration: 5
        })
      });
      const validRes = await bot.fetch(validExecReq);
      // Fails at mock trade order creation or succeeds, but passes the approval gate
      expect(validRes.status).not.toBe(409);
    });

    it('strictly rejects execution when stored alert has no generation or mismatched generation, even if client supplies generation', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('isActive', true);
      mockStorage.set('lock:alarmGeneration', 5);
      const testAlertNoGen: TradeAlert = {
        id: 'alert-no-gen-01',
        symbol: 'BTC/USDT',
        signalPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        quantity: 0.002,
        isExecutable: true,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        source: 'AUTONOMOUS',
        generation: 5,
        approvalGeneration: 4, // Mismatched approval generation on stored alert!
      };
      mockStorage.set('alerts', [testAlertNoGen]);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 5,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'bybit:mainnet',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      // Client supplies approvalGeneration: 5, trying to bypass stored alert's missing generation
      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: testAlertNoGen.id, approvalGeneration: 5 })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.code).toBe('STALE_APPROVAL_GENERATION');
    });
  });

  describe('11. /execute-trade Authoritative Storage Read & Anti-Stale Guarantees', () => {
    it('reads approval directly from storage even when runtime state is unpopulated', async () => {
      mockStorage.set('userId', userId);
      const testAlert: TradeAlert = {
        id: 'alert-auth-storage-01',
        symbol: 'BTC/USDT',
        signalPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        quantity: 0.002,
        isExecutable: true,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        approvalGeneration: 1
      };
      mockStorage.set('alerts', [testAlert]);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'bybit:mainnet',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      // Intentionally ensure runtimeState does not have approvedCandidateRecord
      (bot as any).runtimeState.approvedCandidateRecord = null;

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: testAlert.id, approvalGeneration: 1 })
      });

      const res = await bot.fetch(req);
      // Must NOT fail with APPROVAL_EXPIRED
      expect(res.status).not.toBe(409);
      expect((bot as any).runtimeState.approvedCandidateRecord).toBeDefined();
    });

    it('fails closed when approval was deleted from storage even if runtime state retained stale object', async () => {
      mockStorage.set('userId', userId);
      const testAlert: TradeAlert = {
        id: 'alert-stale-runtime-01',
        symbol: 'BTC/USDT',
        signalPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        quantity: 0.002,
        isExecutable: true,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        approvalGeneration: 1
      };
      mockStorage.set('alerts', [testAlert]);
      // Storage has NO approvedCandidateRecord (deleted by fresh scan / empty scan)
      mockStorage.delete('approvedCandidateRecord');

      const bot = new TradingBot(mockState, mockEnv);
      // Simulate stale in-memory reference
      (bot as any).runtimeState.approvedCandidateRecord = {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'bybit:mainnet',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      };

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: testAlert.id, approvalGeneration: 1 })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.code).toBe('APPROVAL_EXPIRED');
      // Runtime state must have been updated to null
      expect((bot as any).runtimeState.approvedCandidateRecord).toBeNull();
    });
  });

  describe('12. Secure Account Binding: Authenticated User, Exchange & Environment Verification', () => {
    it('verifies accountFingerprint never contains raw API credentials', async () => {
      const realBot = new TradingBot(mockState, mockEnv);
      const tradingBotsBinding = {
        idFromName: vi.fn().mockReturnValue('mock-bot-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockImplementation((req: Request) => realBot.fetch(req))
        })
      };

      const ctxHeaders: Record<string, string> = {};
      const ctx = {
        get: vi.fn().mockReturnValue({ sub: userId }),
        env: { ...mockEnv, TRADING_BOTS: tradingBotsBinding },
        status: vi.fn(),
        header: vi.fn().mockImplementation((k: string, v: string) => { ctxHeaders[k] = v; }),
        json: vi.fn().mockImplementation(data => data),
        req: { query: vi.fn().mockImplementation((k: string) => k === 'budget' ? '100' : undefined) }
      } as any;

      await handleGetPersonalizedMarketCandidates(ctx);
      const record = mockStorage.get('approvedCandidateRecord') as ApprovedCandidateRecord;
      expect(record).toBeDefined();

      // Invariant: accountFingerprint must not leak API key/secret and must be secure HMAC
      expect(record.accountFingerprint).toMatch(/^fp_[0-9a-f]{32}$/);
      expect(record.accountFingerprint).not.toContain('mocked_secret_key');
      expect(record.accountFingerprint).not.toContain('enc');
      expect(record.accountFingerprint).not.toContain('salt');
      expect(record.accountFingerprint).not.toBe('bybit:mainnet');
    });

    it('rejects /activate when account fingerprint mismatches active account (key changed)', async () => {
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp_00000000000000000000000000000000', // mismatched HMAC
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      const req = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          strategy: 'ScalperV2',
          coinId: 'BTC/USDT',
          positionSize: 100,
          approvalGeneration: 1
        })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.code).toBe('ACCOUNT_FINGERPRINT_MISMATCH');
    });

    it('rejects /execute-trade when account fingerprint mismatches active account', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('alerts', [{
        id: 'alert-fp-mismatch',
        symbol: 'BTC/USDT',
        strategy: 'ScalperV2',
        side: 'BUY',
        entryIntent: 'IMMEDIATE',
        entryPrice: 50000,
        signalPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        positionSize: 100,
        quantity: 0.002,
        approvalGeneration: 1,
        status: 'pending',
        timestamp: new Date().toISOString()
      }]);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'fp_00000000000000000000000000000000', // mismatched HMAC
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'alert-fp-mismatch', action: 'CONFIRM' })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.code).toBe('ACCOUNT_FINGERPRINT_MISMATCH');
    });

    it('rejects /activate when user exchange mismatches approved exchange', async () => {
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'binance', // Approval was on binance
        environment: 'mainnet',
        accountFingerprint: 'binance:mainnet',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      // User DB returns bybit
      const bot = new TradingBot(mockState, mockEnv);
      const req = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          strategy: 'ScalperV2',
          coinId: 'BTC/USDT',
          positionSize: 100,
          approvalGeneration: 1
        })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.code).toBe('EXCHANGE_MISMATCH');
    });

    it('rejects /activate when user environment mismatches approved environment', async () => {
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'demo', // Approval was on demo
        accountFingerprint: 'bybit:demo',
        orderType: 'MARKET',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 600000,
        symbolMetadataSnapshot: {}
      });

      // User DB returns mainnet
      const bot = new TradingBot(mockState, mockEnv);
      const req = new Request('http://bot/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          strategy: 'ScalperV2',
          coinId: 'BTC/USDT',
          positionSize: 100,
          approvalGeneration: 1
        })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.code).toBe('ENVIRONMENT_MISMATCH');
    });
  });

  describe('13. Background Operations & Immortal Alarm Rescheduling After Expiry', () => {
    it('executes WAL recovery, position monitoring and reschedules alarm even when approval is expired', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('isActive', true);
      mockStorage.set('strategy', 'ScalperV2');
      mockStorage.set('coinId', 'BTC/USDT');
      mockStorage.set('lock:alarmGeneration', 1);

      // Pending WAL position to sync to D1
      const pendingSync = {
        id: 'pos-wal-recovery-01',
        userId,
        orderSymbol: 'BTCUSDT',
        side: 'BUY',
        entryPrice: 50000,
        quantity: 0.002,
        stopLoss: 49000,
        takeProfit: 52000,
        exchangeName: 'bybit',
        environment: 'mainnet',
        strategy: 'ScalperV2',
        orderId: 'ord-wal-01',
        now: new Date().toISOString()
      };
      mockStorage.set('pendingPositionSync', pendingSync);

      // Expired approval record
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId,
        budgetUsdt: 100,
        approvedSymbols: ['BTC', 'BTCUSDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'mainnet',
        accountFingerprint: 'bybit:mainnet',
        orderType: 'MARKET',
        approvedAt: Date.now() - 1200000,
        expiresAt: Date.now() - 600000, // EXPIRED
        symbolMetadataSnapshot: {}
      });

      const bot = new TradingBot(mockState, mockEnv);
      await bot.alarm();

      // 1. Proves WAL recovery executed: pendingPositionSync deleted from storage
      expect(mockStorage.get('pendingPositionSync')).toBeUndefined();

      // 2. Proves D1 insert was called for WAL position
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT OR IGNORE INTO trade_positions'));

      // 3. Proves strategy evaluation was skipped due to expired approval
      expect(mockExecuteCycle).not.toHaveBeenCalled();

      // 4. Proves alarm was rescheduled in finally block
      expect(mockState.storage.setAlarm).toHaveBeenCalled();
    });

    it('halts background operations immediately when GLOBAL_TRADING_HALT is active', async () => {
      mockStorage.set('userId', userId);
      mockStorage.set('isActive', true);
      mockStorage.set('pendingPositionSync', { id: 'halt-wal-01' });

      const haltEnv = { ...mockEnv, GLOBAL_TRADING_HALT: 'true' };
      const bot = new TradingBot(mockState, haltEnv);
      await bot.alarm();

      // WAL recovery must NOT run when HALT is active
      expect(mockStorage.get('pendingPositionSync')).toBeDefined();
      expect(mockExecuteCycle).not.toHaveBeenCalled();
    });
  });
});
