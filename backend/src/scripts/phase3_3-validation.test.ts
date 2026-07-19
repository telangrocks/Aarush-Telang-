import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReconciliationEngine } from '../exchanges/ReconciliationEngine';
import { TradingBot } from '../trading-bot';

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
      mockEnv.DB.prepare = (sql: string) => {
        return {
          bind: (...args: any[]) => ({
            run: async () => {
              if (sql.includes('INSERT OR IGNORE INTO trade_positions')) {
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
          prepare: (sql: string) => ({
            bind: (...args: any[]) => ({
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

    it('should identify orphaned position, validate it, and reconcile', async () => {
      // Mock exchange has 1 position, D1 has 0
      mockAdapter.fetchPositions = async () => ({
        success: true,
        result: [{ symbol: 'BTCUSDT', size: 1, entryPrice: 50000, side: 'long', leverage: 10 }]
      });

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

      // Cycle 1: Detect and mark PENDING
      await engine.runReconciliationSweep();
      let txs = mockStorage.get('recoveryTransactions');
      expect(txs.has('pos_BTCUSDT')).toBe(true);
      expect(txs.get('pos_BTCUSDT').status).toBe('RECOVERY_VALIDATING'); // It transitions pending -> validating during the first sweep

      // Cycle 2: Validate -> Reconcile
      let dbInsertCalled = false;
      mockEnv.DB.prepare = (sql: string) => {
        return {
          bind: (...args: any[]) => ({
            run: async () => { if (sql.includes('INSERT INTO trade_positions')) dbInsertCalled = true; },
            all: async () => ({ results: [] })
          })
        };
      };
      await engine.runReconciliationSweep();
      
      // Cycle 3: Reconcile -> Complete
      await engine.runReconciliationSweep();
      
      txs = mockStorage.get('recoveryTransactions');
      // Because it transitions all the way to completed and is cleaned up immediately
      expect(txs.has('pos_BTCUSDT')).toBe(false);
      expect(dbInsertCalled).toBe(true);
    });

    it('should trigger Safe Mode on unsafe position validation', async () => {
      // Mock exchange has 1 position with unsafe leverage (e.g., 50x)
      mockAdapter.fetchPositions = async () => ({
        success: true,
        result: [{ symbol: 'BTCUSDT', size: 1, entryPrice: 50000, side: 'long', leverage: 50 }]
      });

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
      
      // Cycle 2: VALIDATING -> FAILED -> SAFE MODE
      await engine.runReconciliationSweep();
      
      // Should have triggered safe mode
      expect(mockStorage.get('safeMode')).toBe(true);
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
