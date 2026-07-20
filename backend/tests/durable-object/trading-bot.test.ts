import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot } from "../../src/trading-bot";
import { StrategyOrchestrator } from "../../src/engine/orchestrator/StrategyOrchestrator";

// Mock the StrategyOrchestrator prototype
vi.mock("../../src/engine/orchestrator/StrategyOrchestrator", () => {
  const StrategyOrchestratorMock = vi.fn();
  StrategyOrchestratorMock.prototype.setMarketDataEngine = vi.fn();
  StrategyOrchestratorMock.prototype.executeCycle = vi.fn().mockResolvedValue([
    {
      strategyId: 'scalper-v2',
      hasSignal: true,
      metadata: {
        signal: {
          type: 'BUY',
          stopLoss: 59000,
          takeProfit: 62000
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
      first: vi.fn().mockResolvedValue({
        exchange_name: 'binance',
        exchange_environment: 'testnet',
        exchange_region: 'global'
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
  });

  it("should not execute Orchestrator if GLOBAL_TRADING_HALT is true", async () => {
    mockEnv.GLOBAL_TRADING_HALT = "true";
    const bot = new TradingBot(mockState, mockEnv);
    
    mockStorage.set('isActive', true);
    await bot.alarm();

    expect(mockStorage.get('engineState')).toBeUndefined();
    expect(mockState.storage.setAlarm).toHaveBeenCalled();
  });
});
