import { describe, it, expect, beforeEach } from 'vitest';
import { ReconciliationEngine } from '../../src/exchanges/ReconciliationEngine';
import { TradingBot } from '../../src/trading-bot';

describe('Phase 3.3: Recovery & Exchange Reconciliation', () => {

  describe('1. Write-Ahead Logging (WAL) Recovery', () => {
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
          delete: async (key: string) => mockStorage.delete(key),
          setAlarm: async (_ms: number) => {},
          list: async () => mockStorage,
        },
        blockConcurrencyWhile: async (cb: () => Promise<any>) => await cb()
      };

      mockEnv = {
        DB: {
          prepare: (_sql: string) => ({
            bind: (..._args: any[]) => ({
              first: async () => null,
              run: async () => {
                // Simulate DB success
              },
              all: async () => ({ results: [] })
            })
          })
        },
        GLOBAL_TRADING_HALT: 'false'
      };
    });

    it('should flush pending WAL position on alarm()', async () => {
      // Simulate WAL containing a position
      mockStorage.set('pendingPositionSync', {
        id: 'mock-pos',
        userId: 'test',
        orderSymbol: 'BTCUSDT',
        side: 'BUY',
        entryPrice: 50000,
        quantity: 1,
        now: new Date().toISOString()
      });

      let dbInsertCalled = false;
      mockEnv.DB.prepare = (_sql: string) => {
        return {
          bind: (..._args: any[]) => ({
            run: async () => {
              if (_sql.includes('INSERT OR IGNORE INTO trade_positions')) {
                dbInsertCalled = true;
              }
            },
            all: async () => ({ results: [] }),
            first: async () => null
          })
        };
      };

      const bot = new TradingBot(mockState, mockEnv);
      (bot as any).runAnalysisCycle = async () => {}; // mock
      
      await bot.alarm();
      
      expect(dbInsertCalled).toBe(true);
      expect(mockStorage.get('pendingPositionSync')).toBeUndefined();
    });
  });

  describe('2. Reconciliation Engine & Safe Mode', () => {
    let mockStorage: Map<string, any>;
    let mockEnv: any;
    let mockAdapter: any;

    beforeEach(() => {
      mockStorage = new Map<string, any>();
      mockEnv = {
        DB: {
          prepare: (_sql: string) => ({
            bind: (..._args: any[]) => ({
              run: async () => {},
              first: async () => null,
              all: async () => ({ results: [] }) // Assume no known positions
            })
          })
        }
      };

      mockAdapter = {
        fetchPositions: async () => ({ success: true, result: [] }),
        fetchOpenOrders: async () => ({ success: true, result: [] }),
        cancelOrder: async () => ({ success: true })
      };
    });

    it('should cancel orphaned orders', async () => {
      mockAdapter.fetchOpenOrders = async () => ({
        success: true,
        result: [{ id: 'order-123', symbol: 'BTCUSDT' }]
      });
      
      let cancelCalled = false;
      mockAdapter.cancelOrder = async () => {
        cancelCalled = true;
        return { success: true };
      };

      const engine = new ReconciliationEngine(
        { 
          get: async (k) => mockStorage.get(k), 
          put: async (k, v) => mockStorage.set(k, v),
          delete: async (k) => mockStorage.delete(k)
        } as any, 
        mockEnv, 
        'user-1', 
        mockAdapter, 
        {}
      );

      // Cycle 1: PENDING -> VALIDATING
      await engine.runReconciliationSweep();
      
      // Cycle 2: VALIDATING -> RECONCILING
      await engine.runReconciliationSweep();

      // Cycle 3: RECONCILING -> COMPLETED (Process cancellation)
      await engine.runReconciliationSweep();
      
      expect(cancelCalled).toBe(true);
      expect(mockStorage.get('lastReconciliationSummary').recoveredPositions).toBe(1); // the order
    });
  });

});
