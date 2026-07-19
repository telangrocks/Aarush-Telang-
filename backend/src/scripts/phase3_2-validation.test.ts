import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreaker } from '../exchanges/CircuitBreaker';
import { TradingBot } from '../trading-bot';

describe('Phase 3.2: Protection Mechanisms Validation', () => {

  describe('1. Circuit Breaker Validation', () => {
    let breaker: CircuitBreaker;

    beforeEach(() => {
      breaker = new CircuitBreaker(3, 1000); // 3 failures, 1s reset timeout
    });

    it('should transition CLOSED -> OPEN -> HALF_OPEN -> CLOSED correctly', async () => {
      // 1. Initial State
      let check = breaker.check();
      expect(check.allowed).toBe(true);
      expect(check.state).toBe('CLOSED');

      // 2. Record 2 failures (threshold 3)
      breaker.recordFailure();
      breaker.recordFailure();
      check = breaker.check();
      expect(check.allowed).toBe(true);
      expect(check.state).toBe('CLOSED');

      // 3. Tripping the breaker (3rd failure)
      breaker.recordFailure();
      check = breaker.check();
      expect(check.allowed).toBe(false);
      expect(check.state).toBe('OPEN');

      // 4. Try to record success while OPEN
      breaker.recordSuccess();
      check = breaker.check();
      expect(check.allowed).toBe(false);
      expect(check.state).toBe('OPEN'); // Should remain OPEN

      // 5. Wait for reset timeout
      await new Promise(r => setTimeout(r, 1100));
      check = breaker.check();
      expect(check.allowed).toBe(true);
      expect(check.state).toBe('HALF_OPEN');

      // 6. Success in HALF_OPEN transitions to CLOSED
      breaker.recordSuccess();
      check = breaker.check();
      expect(check.allowed).toBe(true);
      expect(check.state).toBe('CLOSED');
    });
  });

  describe('2. Global Trading Kill Switch & Health Endpoint Validation', () => {
    let mockStorage: Map<string, any>;
    let mockState: any;
    let mockEnv: any;

    beforeEach(() => {
      mockStorage = new Map<string, any>();
      mockStorage.set('isActive', true);
      mockStorage.set('userId', 'test-user-123');

      mockState = {
        id: { toString: () => "mock-do-id" },
        storage: {
          get: async (key: string) => mockStorage.get(key),
          put: async (key: string, value: any) => mockStorage.set(key, value),
          setAlarm: async (ms: number) => {},
          list: async () => mockStorage,
        },
        blockConcurrencyWhile: async (cb: () => Promise<any>) => await cb()
      };

      mockEnv = {
        DB: {
          prepare: (sql: string) => ({
            bind: (...args: any[]) => ({
              first: async () => null,
              run: async () => {}
            })
          })
        },
        GLOBAL_TRADING_HALT: 'false'
      };
    });

    it('should allow trading when Kill Switch is OFF', async () => {
      mockEnv.GLOBAL_TRADING_HALT = 'false';
      const bot = new TradingBot(mockState, mockEnv);

      const req = new Request("https://mock/execute-trade", { method: 'POST', body: JSON.stringify({}) });
      const res = await bot.fetch(req);
      
      expect(res.status).not.toBe(503);
    });

    it('should block trading and return 503 when Kill Switch is ON', async () => {
      mockEnv.GLOBAL_TRADING_HALT = 'true';
      const bot = new TradingBot(mockState, mockEnv);

      const req = new Request("https://mock/execute-trade", { method: 'POST', body: JSON.stringify({}) });
      const res = await bot.fetch(req);
      
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toContain("safely suspended");
    });

    it('should reflect kill switch status correctly in /health endpoint', async () => {
      // ON
      mockEnv.GLOBAL_TRADING_HALT = 'true';
      let bot = new TradingBot(mockState, mockEnv);
      let res = await bot.fetch(new Request("https://mock/health"));
      let data = await res.json();
      expect(data.globalTradingHalt).toBe(true);
      expect(data.version).toBe('1.0.0-phase3.2');
      expect(data.activePositionsCount).toBe(0);

      // OFF
      mockEnv.GLOBAL_TRADING_HALT = 'false';
      bot = new TradingBot(mockState, mockEnv);
      res = await bot.fetch(new Request("https://mock/health"));
      data = await res.json();
      expect(data.globalTradingHalt).toBe(false);
    });

    it('should abort background analysis in alarm() if kill switch is ON', async () => {
      mockEnv.GLOBAL_TRADING_HALT = 'true';
      const bot = new TradingBot(mockState, mockEnv);

      let analysisRan = false;
      (bot as any).runAnalysisCycle = async () => { analysisRan = true; };

      await bot.alarm();
      expect(analysisRan).toBe(false);
    });

    it('should run background analysis in alarm() if kill switch is OFF', async () => {
      mockEnv.GLOBAL_TRADING_HALT = 'false';
      const bot = new TradingBot(mockState, mockEnv);

      let analysisRan = false;
      (bot as any).runAnalysisCycle = async () => { analysisRan = true; };

      await bot.alarm();
      expect(analysisRan).toBe(true);
    });
  });

});
