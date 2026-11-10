import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('mocked_secret_key'),
  encrypt: vi.fn().mockResolvedValue({ iv: 'iv', encrypted: 'enc', salt: 'salt' }),
}));

import { TradingBot, TradeAlert } from '../../src/trading-bot';
import { sendTradeNotification } from '../../src/handlers/notifications';
import { BackendDiagnosticSink } from '../../src/telemetry/BackendDiagnosticSink';
import { StrategyRegistry } from '../../src/engine/strategies/StrategyRegistry';
import { ExchangeManager } from '../../src/exchanges/ExchangeManager';
import BigNumber from 'bignumber.js';

describe('End-to-End Approved Quantity Verification & Safety Tests', () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockSink: any;

  beforeEach(() => {
    mockStorage = new Map<string, any>();
    mockState = {
      storage: {
        get: vi.fn(async (key: string) => mockStorage.get(key)),
        put: vi.fn(async (key: string, val: any) => mockStorage.set(key, val)),
        delete: vi.fn(async (key: string) => mockStorage.delete(key)),
        list: vi.fn(async () => new Map()),
        transaction: vi.fn(async (closure: (txn: any) => Promise<any>) => {
          const txn = {
            get: vi.fn(async (k: string) => mockStorage.get(k)),
            put: vi.fn(async (k: string, v: any) => mockStorage.set(k, v)),
            delete: vi.fn(async (k: string) => mockStorage.delete(k)),
            list: vi.fn(async () => new Map()),
          };
          return await closure(txn);
        }),
      },
      blockConcurrencyWhile: vi.fn(async (fn: () => Promise<any>) => await fn()),
      waitUntil: vi.fn(),
    };

    const mockStmt: any = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({
        id: 'usr_test_1',
        exchange_name: 'bybit',
        exchange_environment: 'testnet',
        exchange_api_key_encrypted: 'mock_key',
        exchange_api_secret_encrypted: 'mock_secret',
        fcm_token: 'valid_fcm_token_123',
      }),
      all: vi.fn().mockResolvedValue({
        results: [
          { name: 'target_entry_price' },
          { name: 'entry_status' },
        ],
      }),
      run: vi.fn().mockResolvedValue({ success: true }),
    };

    mockEnv = {
      DB: {
        prepare: vi.fn().mockReturnValue(mockStmt),
      },
      ENCRYPTION_KEY: 'test-encryption-key-must-be-32b!',
      FCM_SERVER_KEY: 'mock_server_key',
      ENVIRONMENT: 'testing',
    };

    mockSink = new BackendDiagnosticSink({ db: null });
    vi.spyOn(mockSink, 'emit').mockImplementation(() => {});

    // Ensure StrategyRegistry is initialized
    StrategyRegistry.getInstance();
  });

  describe('FCM Notification Payload Serialization', () => {
    it('serializes quantity, requestedBudget, and effectiveNotional into dataPayload', async () => {
      let dispatchedBody: any = null;
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: any) => {
        if (url.includes('fcm.googleapis.com')) {
          dispatchedBody = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ success: 1 }),
          };
        }
        return { ok: true, status: 200, text: async () => '{}' };
      });

      await sendTradeNotification(mockEnv, 'usr_test_1', 'alert_pepe_1', {
        symbol: '1000PEPEUSDT',
        side: 'BUY',
        entryPrice: 0.004962,
        stopLoss: 0.004714,
        takeProfit: 0.005458,
        estimatedPnl: 496.15,
        positionSize: 4961.50,
        requestedBudget: 5555.0,
        quantity: 999900,
        requestedBudget: 5555.0,
        effectiveNotional: 4961.5038,
        strategy: 'ScalperV2',
      }, mockSink);

      expect(dispatchedBody).not.toBeNull();
      const data = dispatchedBody.data;
      expect(data.quantity).toBe('999900');
      expect(data.requestedBudget).toBe('5555');
      expect(data.effectiveNotional).toBe('4961.5038');
      expect(data.symbol).toBe('1000PEPEUSDT');
      expect(data.side).toBe('BUY');
    });

    it('never sends missing, non-finite, zero, or negative quantities as valid instructions', async () => {
      let dispatchedBody: any = null;
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: any) => {
        if (url.includes('fcm.googleapis.com')) {
          dispatchedBody = JSON.parse(init.body);
          return { ok: true, status: 200, text: async () => JSON.stringify({ success: 1 }) };
        }
        return { ok: true, status: 200, text: async () => '{}' };
      });

      await sendTradeNotification(mockEnv, 'usr_test_1', 'alert_invalid_qty', {
        symbol: 'BTCUSDT',
        side: 'BUY',
        entryPrice: 50000,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 20,
        quantity: -5, // Invalid negative
        requestedBudget: 0, // Invalid zero
        effectiveNotional: NaN, // Invalid NaN
        strategy: 'ScalperV2',
      }, mockSink);

      expect(dispatchedBody).not.toBeNull();
      const data = dispatchedBody.data;
      expect(data.quantity).toBeUndefined();
      expect(data.requestedBudget).toBeUndefined();
      expect(data.effectiveNotional).toBeUndefined();
    });

    it('preserves exact decimal quantities without floating point precision corruption', async () => {
      let dispatchedBody: any = null;
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: any) => {
        if (url.includes('fcm.googleapis.com')) {
          dispatchedBody = JSON.parse(init.body);
          return { ok: true, status: 200, text: async () => JSON.stringify({ success: 1 }) };
        }
        return { ok: true, status: 200, text: async () => '{}' };
      });

      await sendTradeNotification(mockEnv, 'usr_test_1', 'alert_sol_1', {
        symbol: 'SOLUSDT',
        side: 'BUY',
        entryPrice: 95.42,
        stopLoss: 93.51,
        takeProfit: 99.23,
        estimatedPnl: 221.74,
        positionSize: 5553.44,
        quantity: 58.2, // Decimal quantity
        requestedBudget: 5555.0,
        effectiveNotional: 5553.444,
        strategy: 'ScalperV2',
      }, mockSink);

      expect(dispatchedBody).not.toBeNull();
      const data = dispatchedBody.data;
      expect(data.quantity).toBe('58.2');
      expect(data.requestedBudget).toBe('5555');
      expect(data.effectiveNotional).toBe('5553.444');
    });
  });

  describe('TradingBot /execute-trade Verification Gates', () => {
    let bot: TradingBot;

    beforeEach(() => {
      bot = new TradingBot(mockState, mockEnv);
      mockStorage.set('userId', 'usr_test_1');
      mockStorage.set('isActive', true);
      mockStorage.set('lock:alarmGeneration', 1);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId: 'usr_test_1',
        budgetUsdt: 5555.0,
        approvedSymbols: ['1000PEPE', '1000PEPEUSDT', '1000PEPE/USDT', 'SOL', 'SOLUSDT', 'SOL/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'testnet',
        accountFingerprint: 'bybit:testnet',
        orderType: 'ALL',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        symbolMetadataSnapshot: {}
      });

      const marketInfo = {
        symbol: '1000PEPE/USDT',
        limits: {
          amount: { min: 100, max: 999999 },
          cost: { min: 5 },
        },
        precision: {
          amount: 100,
          price: 0.000001,
        },
      };

      // Register mock exchange provider
      const mockAdapter: any = {
        fetchTicker: vi.fn().mockResolvedValue({ last: 0.004962 }),
        fetchOrderBook: vi.fn().mockResolvedValue({
          bids: [[0.004961, 1000000]],
          asks: [[0.004963, 1000000]],
        }),
        createOrder: vi.fn().mockResolvedValue({
          id: 'bybit_order_123',
          status: 'closed',
          filled: new BigNumber(999900),
          amount: new BigNumber(999900),
          price: new BigNumber(0.004962),
          average: new BigNumber(0.004962),
        }),
        fetchPositions: vi.fn().mockImplementation(async (cat, sym, zero) => (sym && zero ? [{ symbol: sym, positionIdx: 0, size: new BigNumber(0) }] : [])),
        fetchBalance: vi.fn().mockResolvedValue({
          free: { USDT: 10000 },
          total: { USDT: 10000 },
        }),
        setLeverage: vi.fn().mockResolvedValue({}),
        setMarginMode: vi.fn().mockResolvedValue({}),
        fetchMarket: vi.fn().mockResolvedValue(marketInfo),
        fetchMarkets: vi.fn().mockResolvedValue([marketInfo]),
      };

      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter);
      vi.spyOn(ExchangeManager, 'executeIdempotentOrder').mockResolvedValue({
        id: 'bybit_order_123',
        status: 'closed',
        filled: new BigNumber(999900),
        amount: new BigNumber(999900),
        price: new BigNumber(0.004962),
        average: new BigNumber(0.004962),
      });
    });

    it('rejects tampered quantity with HTTP 409 QUANTITY_TAMPERED', async () => {
      const alert: TradeAlert = {
        id: 'alert_tamper_test',
        symbol: '1000PEPE/USDT',
        signalPrice: 0.004962,
        entryPrice: 0.004962,
        stopLoss: 0.004714,
        takeProfit: 0.005458,
        estimatedPnl: 496.15,
        positionSize: 4961.50,
        requestedBudget: 5555.0,
        quantity: 999900, // Approved: 999,900
        requestedBudget: 5555.0,
        effectiveNotional: 4961.50,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      };
      mockStorage.set('alerts', [alert]);

      // Client attempts to execute with tampered quantity 1,118,300
      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: 'alert_tamper_test',
          quantity: 1118300,
          requireApprovedQuantity: true,
        }),
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json<any>();
      expect(data.code).toBe('QUANTITY_TAMPERED');
      expect(data.error).toContain('does not match the approved quantity');
    });

    it('rejects missing or invalid quantity with HTTP 400 MISSING_SUBMITTED_QUANTITY', async () => {
      const alert: TradeAlert = {
        id: 'alert_missing_qty_test',
        symbol: '1000PEPE/USDT',
        signalPrice: 0.004962,
        entryPrice: 0.004962,
        stopLoss: 0.004714,
        takeProfit: 0.005458,
        estimatedPnl: 496.15,
        positionSize: 4961.50,
        requestedBudget: 5555.0,
        quantity: 999900,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      };
      mockStorage.set('alerts', [alert]);

      // Client submits without quantity
      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: 'alert_missing_qty_test',
          requireApprovedQuantity: true,
        }),
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(400);
      const data = await res.json<any>();
      expect(data.code).toBe('MISSING_SUBMITTED_QUANTITY');
    });

    it('rejects mismatched symbol with HTTP 400 MISMATCHED_ALERT_SYMBOL', async () => {
      const alert: TradeAlert = {
        id: 'alert_mismatch_sym',
        symbol: 'SOL/USDT',
        signalPrice: 95.0,
        entryPrice: 95.0,
        stopLoss: 93.0,
        takeProfit: 99.0,
        estimatedPnl: 200,
        positionSize: 5000,
        requestedBudget: 5555.0,
        quantity: 50,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      };
      mockStorage.set('alerts', [alert]);

      // Client submits with mismatched symbol BTCUSDT
      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: 'alert_mismatch_sym',
          symbol: 'BTCUSDT',
          quantity: 50,
        }),
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(400);
      const data = await res.json<any>();
      expect(data.code).toBe('MISMATCHED_ALERT_SYMBOL');
    });

    it('rejects mismatched side with HTTP 400 MISMATCHED_ALERT_SIDE', async () => {
      const alert: TradeAlert = {
        id: 'alert_mismatch_side',
        symbol: 'SOL/USDT',
        signalPrice: 95.0,
        entryPrice: 95.0,
        stopLoss: 93.0,
        takeProfit: 99.0,
        estimatedPnl: 200,
        positionSize: 5000,
        requestedBudget: 5555.0,
        quantity: 50,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      };
      mockStorage.set('alerts', [alert]);

      // Client submits with mismatched side SELL
      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: 'alert_mismatch_side',
          side: 'SELL',
          quantity: 50,
        }),
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(400);
      const data = await res.json<any>();
      expect(data.code).toBe('MISMATCHED_ALERT_SIDE');
    });

    it('rejects stale alert (> 300,000ms TTL) with HTTP 400 Signal has expired', async () => {
      const staleTimestamp = new Date(Date.now() - 350000).toISOString(); // 5.8 minutes ago
      const alert: TradeAlert = {
        id: 'alert_stale_test',
        symbol: 'SOL/USDT',
        signalPrice: 95.0,
        entryPrice: 95.0,
        stopLoss: 93.0,
        takeProfit: 99.0,
        estimatedPnl: 200,
        positionSize: 5000,
        requestedBudget: 5555.0,
        quantity: 50,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: staleTimestamp,
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      };
      mockStorage.set('alerts', [alert]);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: 'alert_stale_test',
          quantity: 50,
        }),
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(400);
      const data = await res.json<any>();
      expect(data.error).toContain('Signal has expired');
    });

    it('accepts exact approved quantity and submits identical quantity to exchange', async () => {
      const alert: TradeAlert = {
        id: 'alert_exact_pepe',
        symbol: '1000PEPE/USDT',
        signalPrice: 0.004962,
        entryPrice: 0.004962,
        stopLoss: 0.004714,
        takeProfit: 0.005458,
        estimatedPnl: 496.15,
        positionSize: 4961.50,
        requestedBudget: 5555.0,
        quantity: 999900,
        requestedBudget: 5555.0,
        effectiveNotional: 4961.50,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      };
      mockStorage.set('alerts', [alert]);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: 'alert_exact_pepe',
          symbol: '1000PEPEUSDT',
          side: 'BUY',
          quantity: 999900,
          positionSizeUsdt: 5555.0,
          requireApprovedQuantity: true,
        }),
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.success).toBe(true);
      expect(data.quantity).toBe(999900);
      expect(ExchangeManager.executeIdempotentOrder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          symbol: '1000PEPE/USDT',
          amount: new BigNumber(999900),
        })
      );
    });
  });
});
