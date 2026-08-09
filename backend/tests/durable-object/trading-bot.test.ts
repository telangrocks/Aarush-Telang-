import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot } from "../../src/trading-bot";

// Mock security crypto
vi.mock("../../src/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key")
}));

// Mock exchanges adapter
vi.mock("../../src/exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: vi.fn().mockResolvedValue({ symbol: 'BTCUSDT', last: 50100, bid: 50090, ask: 50110, high: 51000, low: 49000, volume: 100, quoteVolume: 5010000 }),
        fetchKlines: vi.fn().mockResolvedValue([{ openTime: Date.now(), open: 50000, high: 51000, low: 49000, close: 50500, volume: 100 }]),
        fetchBalance: vi.fn().mockResolvedValue([]),
        fetchMarkets: vi.fn().mockResolvedValue([]),
        createOrder: vi.fn().mockResolvedValue({ id: 'ord-123', status: 'closed', filled: { toNumber: () => 0.02 }, amount: { toNumber: () => 0.02 }, average: { toNumber: () => 50100 } }),
        supportsOco: vi.fn().mockReturnValue(false),
        createOcoOrder: vi.fn()
      }),
      executeIdempotentOrder: vi.fn().mockResolvedValue({ id: 'ord-123', status: 'closed', filled: { toNumber: () => 0.02 }, amount: { toNumber: () => 0.02 }, average: { toNumber: () => 50100 } }),
      executeIdempotentOcoOrder: vi.fn()
    },
    normalizeEnvironment: vi.fn().mockReturnValue('testnet'),
    normalizeRegion: vi.fn().mockReturnValue('global'),
  };
});

// Mock the StrategyOrchestrator prototype
vi.mock("../../src/engine/orchestrator/StrategyOrchestrator", () => {
  const StrategyOrchestratorMock = vi.fn();
  StrategyOrchestratorMock.prototype.setMarketDataEngine = vi.fn();
  StrategyOrchestratorMock.prototype.executeCycle = vi.fn().mockResolvedValue([
    {
      strategyId: 'scalper-v2',
      confidenceScore: 75,
      hasSignal: true,
      metadata: {
        signal: {
          type: 'BUY',
          stopLoss: 59000,
          takeProfit: 62000,
          riskAssessment: {
            positionSizeRecommendation: 1000
          }
        }
      }
    }
  ]);
  StrategyOrchestratorMock.prototype.getCurrentState = vi.fn().mockReturnValue('ACTIVE');

  return {
    StrategyOrchestrator: StrategyOrchestratorMock
  };
});

describe("Trading Bot Durable Object - Architecture v2.0", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockDb: any;

  beforeEach(() => {
    mockStorage = new Map();
    mockState = {
      id: { toString: () => "mock-do-id" },
      storage: {
        get: async (key: string) => mockStorage.get(key),
        put: async (key: string, val: any) => mockStorage.set(key, val),
        delete: async (key: string) => mockStorage.delete(key),
        setAlarm: vi.fn(),
        list: async () => mockStorage
      },
      blockConcurrencyWhile: async (cb: any) => cb()
    };

    mockDb = {
      prepare: vi.fn().mockReturnThis(),
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({ success: true }),
      first: vi.fn().mockResolvedValue({
        exchange_name: 'binance',
        exchange_environment: 'testnet',
        exchange_region: 'global',
        exchange_api_key: 'mock_api_key',
        exchange_api_secret_encrypted: 'mock_secret',
        exchange_api_secret_iv: 'mock_iv',
      })
    };

    mockEnv = {
      DB: mockDb,
      GLOBAL_TRADING_HALT: "false"
    };
  });

  it("should execute StrategyOrchestrator in alarm() and generate TradeAlerts", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    
    // Set up DO state for an active run
    mockStorage.set('isActive', true);
    mockStorage.set('coinId', 'BTC');
    mockStorage.set('userId', 'user-123');
    mockStorage.set('strategy', 'scalper-v2');

    // Trigger the alarm
    await bot.alarm();

    // Check that engineState was populated
    expect(mockStorage.get('engineState')).toBe('ACTIVE');

    // Check that newAnalysis DTO was populated
    const newAnalysis = mockStorage.get('newAnalysis');
    expect(newAnalysis).toBeDefined();
    
    // Check that a TradeAlert was generated due to the mock signal
    const alerts = mockStorage.get('alerts');
    expect(alerts).toBeDefined();
    expect(alerts.length).toBe(1);
    expect(alerts[0].symbol).toBe('BTC');
    expect(alerts[0].side).toBe('BUY');
    expect(alerts[0].stopLoss).toBe(59000);
    expect(alerts[0].takeProfit).toBe(62000);
    expect(alerts[0].strategy).toBe('scalper-v2_NEW');
    
    // Check that next alarm was scheduled
    expect(mockState.storage.setAlarm).toHaveBeenCalled();
  }, 10000);

  it("should not execute Orchestrator if GLOBAL_TRADING_HALT is true", async () => {
    mockEnv.GLOBAL_TRADING_HALT = "true";
    const bot = new TradingBot(mockState, mockEnv);
    
    mockStorage.set('isActive', true);
    await bot.alarm();

    expect(mockStorage.get('engineState')).toBeUndefined();
    expect(mockState.storage.setAlarm).toHaveBeenCalled();
  });

  it("Task #1: should block execute-trade with 403 when safeMode is true, reset it via /reset-safemode, and verify analysis-status reports safeMode=false", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-123');
    mockStorage.set('safeMode', true);

    // 1. Verify /execute-trade is blocked with HTTP 403 when safeMode is active
    const blockReq = new Request('http://bot/execute-trade', { method: 'POST' });
    const blockRes = await bot.fetch(blockReq);
    expect(blockRes.status).toBe(403);
    const blockData = await blockRes.json<any>();
    expect(blockData.error).toContain('Safe Mode is active');

    // 2. Verify /deactivate does NOT clear safeMode
    const deactReq = new Request('http://bot/deactivate', { method: 'POST' });
    await bot.fetch(deactReq);
    expect(mockStorage.get('safeMode')).toBe(true);

    // 3. Call /reset-safemode explicit recovery endpoint
    const resetReq = new Request('http://bot/reset-safemode', { method: 'POST' });
    const resetRes = await bot.fetch(resetReq);
    expect(resetRes.status).toBe(200);
    const resetData = await resetRes.json<any>();
    expect(resetData.success).toBe(true);
    expect(resetData.previousState).toBe(true);
    expect(resetData.currentState).toBe(false);
    expect(resetData.message).toBe('Safe Mode cleared.');

    // 4. Verify GET /analysis-status reports safeMode = false
    const statusReq = new Request('http://bot/analysis-status', { method: 'GET' });
    const statusRes = await bot.fetch(statusReq);
    const statusData = await statusRes.json<any>();
    expect(statusData.safeMode).toBe(false);
    expect(mockStorage.get('safeMode')).toBeUndefined();
  });

  it("should execute trade using targetEntryPrice and record averageFillPrice and execution audit in D1", async () => {
    mockDb.run = vi.fn().mockResolvedValue({ success: true });
    mockDb.prepare = vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({ success: true }),
        first: vi.fn().mockResolvedValue({
          exchange_name: 'binance',
          exchange_environment: 'testnet',
          exchange_region: 'global',
          exchange_api_key: 'key',
          exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
          exchange_api_secret_encrypted: 'sec'
        })
      })
    });

    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-123');
    mockStorage.set('coinId', 'BTCUSDT');
    mockStorage.set('targetEntryPrice', 50000);
    mockStorage.set('alerts', [
      {
        id: 'alert-1',
        symbol: 'BTCUSDT',
        signalPrice: 50100,
        targetEntryPrice: 50000,
        entryPrice: 50100,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 0,
        positionSize: 1000,
        strategy: 'scalper-v2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending'
      }
    ]);

    const req = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-123', coinId: 'BTCUSDT' })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    // Verify D1 query executions
    console.log('PREPARE CALLS:', mockDb.prepare.mock.calls);
    const prepareCalls = mockDb.prepare.mock.calls.map((c: any) => c[0]);
    const insertPositionCall = prepareCalls.find((sql: string) => sql.includes('INSERT OR IGNORE INTO trade_positions') && sql.includes('target_entry_price'));
    const insertAuditCall = prepareCalls.find((sql: string) => sql.includes('INSERT INTO audit_log'));

    expect(insertPositionCall).toBeDefined();
    expect(insertAuditCall).toBeDefined();
  });
});
