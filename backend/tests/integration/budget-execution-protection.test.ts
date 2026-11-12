import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('mocked_secret_key'),
  encrypt: vi.fn().mockResolvedValue({ iv: 'iv', encrypted: 'enc', salt: 'salt' }),
}));

import { TradingBot, TradeAlert } from '../../src/trading-bot';
import { BackendDiagnosticSink } from '../../src/telemetry/BackendDiagnosticSink';
import { StrategyRegistry } from '../../src/engine/strategies/StrategyRegistry';
import { ExchangeManager } from '../../src/exchanges/ExchangeManager';
import { TradeValidator } from '../../src/validation/TradeValidator';
import { ExecutionEligibilityGate } from '../../src/engine/scanner/ExecutionEligibilityGate';
import { ValidationErrorReason, SymbolTradingRules } from '../../src/exchanges/types';
import BigNumber from 'bignumber.js';

describe('Budget-to-Execution Protection and Ticker Verification Gates', () => {
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

    StrategyRegistry.getInstance();
  });

  describe('1 & 3: ExecutionEligibilityGate Budget & Bybit Rules Verification', () => {
    it('calculates final quantity strictly respecting budget, minimum notional, and quantity step size', () => {
      // INIT example: Budget = 10 USDT, Price = 0.21949, StepSize = 1, MinOrderQty = 1, MinNotional = 5
      const res = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: 10,
        currentPrice: 0.21949,
        qtyStep: 1,
        minOrderQty: 1,
        minNotional: 5,
      });

      expect(res.isExecutable).toBe(true);
      expect(res.quantizedQty).toBe(45); // floor(10 / 0.21949) = 45
      // 45 * 0.21949 = 9.87705 <= 10
      expect(res.postRoundingNotional).toBeLessThanOrEqual(10);
      expect(res.postRoundingNotional).toBeGreaterThanOrEqual(5);
    });

    it('rejects trade when floor-quantized quantity is below exchange minOrderQty', () => {
      const res = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: 10,
        currentPrice: 20, // 10 / 20 = 0.5 contracts
        qtyStep: 1,
        minOrderQty: 1, // requires at least 1 contract (20 USDT)
        minNotional: 5,
      });

      expect(res.isExecutable).toBe(false);
      expect(res.quantizedQty).toBe(0);
      expect(res.rejectionReason).toContain('minOrderQty');
    });

    it('rejects trade when budget is below minNotional', () => {
      const res = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: 4.5,
        currentPrice: 0.2,
        qtyStep: 1,
        minOrderQty: 1,
        minNotional: 5.0,
      });

      expect(res.isExecutable).toBe(false);
      expect(res.rejectionReason).toContain('below exchange minNotional');
    });
  });

  describe('5 & 8: Pre-Dispatch Execution Budget Safety Check', () => {
    let bot: TradingBot;
    let mockAdapter: any;

    beforeEach(() => {
      bot = new TradingBot(mockState, mockEnv);
      mockStorage.set('userId', 'usr_test_1');
      mockStorage.set('isActive', true);
      mockStorage.set('lock:alarmGeneration', 1);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId: 'usr_test_1',
        budgetUsdt: 10.0,
        approvedSymbols: ['INIT/USDT', 'INITUSDT'],
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
        symbol: 'INIT/USDT',
        limits: {
          amount: { min: 1, max: 100000 },
          cost: { min: 5 },
        },
        precision: {
          amount: 1,
          price: 0.00001,
        },
      };

      mockAdapter = {
        fetchTicker: vi.fn().mockResolvedValue({ last: 0.21949 }),
        fetchOrderBook: vi.fn().mockResolvedValue({
          bids: [[0.2194, 10000]],
          asks: [[0.2195, 10000]],
        }),
        createOrder: vi.fn().mockResolvedValue({
          id: 'bybit_order_init_1',
          status: 'closed',
          filled: new BigNumber(45),
          amount: new BigNumber(45),
          price: new BigNumber(0.21949),
          average: new BigNumber(0.21949),
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
        id: 'bybit_order_init_1',
        status: 'closed',
        filled: new BigNumber(45),
        amount: new BigNumber(45),
        price: new BigNumber(0.21949),
        average: new BigNumber(0.21949),
      });
    });

    it('rejects execution with HTTP 409 BUDGET_EXCEEDED_AT_EXECUTION when market price drifts above budget', async () => {
      // Alert was approved at 0.21949 for 45 units (45 * 0.21949 = 9.877 USDT <= 10.0 USDT)
      const alert: TradeAlert = {
        id: 'alert_init_drift',
        symbol: 'INIT/USDT',
        signalPrice: 0.21949,
        entryPrice: 0.21949,
        stopLoss: 0.21,
        takeProfit: 0.25,
        estimatedPnl: 1.37,
        positionSize: 10.0,
        requestedBudget: 10.0,
        quantity: 45,
        effectiveNotional: 9.877,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      };
      mockStorage.set('alerts', [alert]);

      // Before execution dispatch, market price drifts up to 0.22636: 45 * 0.22636 = 10.1862 USDT > 10.0 USDT
      mockAdapter.fetchTicker.mockResolvedValue({ last: 0.22636 });

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: 'alert_init_drift',
          symbol: 'INIT/USDT',
          side: 'BUY',
          quantity: 45,
          positionSizeUsdt: 10.0,
          entryIntent: 'IMMEDIATE', // Android sends IMMEDIATE for market execution
          requireApprovedQuantity: true,
        }),
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json<any>();
      expect(data.code).toBe('BUDGET_EXCEEDED_AT_EXECUTION');
      expect(data.error).toBe('BUDGET_EXCEEDED_AT_EXECUTION');
      expect(ExchangeManager.executeIdempotentOrder).not.toHaveBeenCalled();

      // Ensure reservation was released and marked failed
      const storedAlerts = mockStorage.get('alerts');
      expect(storedAlerts[0].status).toBe('failed');
    });

    it('validates TradeValidator maxBudgetUsdt constraint correctly', () => {
      const mockRules: SymbolTradingRules = {
        schemaVersion: '2.0',
        symbol: 'INIT/USDT',
        exchange: 'bybit',
        baseAsset: 'INIT',
        quoteAsset: 'USDT',
        minNotional: 5,
        minQty: 1,
        maxQty: 100000,
        stepSize: 1,
        tickSize: 0.00001,
        minPrice: 0.00001,
        maxPrice: 1000000,
        contractSize: 1,
        lastUpdated: Date.now(),
      };

      // Within budget: 45 * 0.21949 = 9.87705 <= 10.0
      const okResult = TradeValidator.validate({
        symbol: 'INIT/USDT',
        entryPrice: 0.21949,
        quantity: 45,
        isApprovedQuantity: true,
        maxBudgetUsdt: 10.0,
      }, mockRules);

      expect(okResult.isValid).toBe(true);
      expect(okResult.quantizedQuantity).toBe(45);

      // Exceeds budget: 45 * 0.22636 = 10.1862 > 10.0
      const exceededResult = TradeValidator.validate({
        symbol: 'INIT/USDT',
        entryPrice: 0.22636,
        quantity: 45,
        isApprovedQuantity: true,
        maxBudgetUsdt: 10.0,
      }, mockRules);

      expect(exceededResult.isValid).toBe(false);
      expect(exceededResult.errorCode).toBe(ValidationErrorReason.BUDGET_EXCEEDED);
      expect(exceededResult.errorMessage).toContain('exceeds approved budget');
    });

    it('executes exact approved quantity when price remains within budget', async () => {
      const alert: TradeAlert = {
        id: 'alert_init_ok',
        symbol: 'INIT/USDT',
        signalPrice: 0.21949,
        entryPrice: 0.21949,
        stopLoss: 0.21,
        takeProfit: 0.25,
        estimatedPnl: 1.37,
        positionSize: 10.0,
        requestedBudget: 10.0,
        quantity: 45,
        effectiveNotional: 9.877,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      };
      mockStorage.set('alerts', [alert]);

      // Price slightly improved to 0.2190: 45 * 0.2190 = 9.855 <= 10.0
      mockAdapter.fetchTicker.mockResolvedValue({ last: 0.2190 });

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: 'alert_init_ok',
          symbol: 'INIT/USDT',
          side: 'BUY',
          quantity: 45,
          positionSizeUsdt: 10.0,
          entryIntent: 'IMMEDIATE',
          requireApprovedQuantity: true,
        }),
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.success).toBe(true);
      expect(data.quantity).toBe(45);
      expect(data.estimatedNotional).toBeDefined();
      expect(data.actualFillNotional).toBeDefined();
      expect(ExchangeManager.executeIdempotentOrder).toHaveBeenCalledTimes(1);
    });

    it('supports SELL direction execution while enforcing budget ceiling and SL/TP protection', async () => {
      const alert: TradeAlert = {
        id: 'alert_sell_test',
        symbol: 'INIT/USDT',
        signalPrice: 0.22,
        entryPrice: 0.22,
        stopLoss: 0.23, // SL higher than entry for short
        takeProfit: 0.20, // TP lower than entry for short
        estimatedPnl: 0.90,
        positionSize: 10.0,
        requestedBudget: 10.0,
        quantity: 45,
        effectiveNotional: 9.90,
        strategy: 'ScalperV2',
        side: 'SELL',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      };
      mockStorage.set('alerts', [alert]);

      mockAdapter.fetchTicker.mockResolvedValue({ last: 0.22 });

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: 'alert_sell_test',
          symbol: 'INIT/USDT',
          side: 'SELL',
          quantity: 45,
          positionSizeUsdt: 10.0,
          entryIntent: 'IMMEDIATE',
          requireApprovedQuantity: true,
        }),
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.success).toBe(true);
      expect(data.side).toBe('SELL');
      expect(data.stopLoss).toBe(0.23);
      expect(data.takeProfit).toBe(0.20);
    });

    it('rejects execution with HTTP 409 PRICE_BREACHED_STOP_LOSS when market price breaches stop loss before BUY execution', async () => {
      const alert: TradeAlert = {
        id: 'alert_sl_breach',
        symbol: 'INIT/USDT',
        signalPrice: 0.22,
        entryPrice: 0.22,
        stopLoss: 0.21,
        takeProfit: 0.25,
        estimatedPnl: 1.37,
        positionSize: 10.0,
        requestedBudget: 10.0,
        quantity: 45,
        effectiveNotional: 9.9,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      };
      mockStorage.set('alerts', [alert]);

      // Price drops to or below Stop Loss (0.209 <= 0.21)
      mockAdapter.fetchTicker.mockResolvedValue({ last: 0.209 });

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: 'alert_sl_breach',
          symbol: 'INIT/USDT',
          side: 'BUY',
          quantity: 45,
          positionSizeUsdt: 10.0,
          entryIntent: 'IMMEDIATE',
          requireApprovedQuantity: true,
        }),
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json<any>();
      expect(data.code).toBe('PRICE_BREACHED_STOP_LOSS');
      expect(data.error).toBe('PRICE_BREACHED_STOP_LOSS');
      expect(ExchangeManager.executeIdempotentOrder).not.toHaveBeenCalled();

      const storedAlerts = mockStorage.get('alerts');
      expect(storedAlerts[0].status).toBe('failed');
    });

    it('rejects execution with HTTP 409 PRICE_BREACHED_TAKE_PROFIT when market price breaches take profit before BUY execution', async () => {
      const alert: TradeAlert = {
        id: 'alert_tp_breach',
        symbol: 'INIT/USDT',
        signalPrice: 0.22,
        entryPrice: 0.22,
        stopLoss: 0.21,
        takeProfit: 0.25,
        estimatedPnl: 1.37,
        positionSize: 10.0,
        requestedBudget: 10.0,
        quantity: 40,
        effectiveNotional: 8.8,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      };
      mockStorage.set('alerts', [alert]);

      // Price moves to or above Take Profit (0.251 >= 0.25)
      // Note: 40 * 0.251 = 10.04 > 10, so let's make quantity 35 so budget is 35 * 0.251 = 8.785 <= 10.0
      // That isolates the TP breach check
      alert.quantity = 35;
      mockAdapter.fetchTicker.mockResolvedValue({ last: 0.251 });

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: 'alert_tp_breach',
          symbol: 'INIT/USDT',
          side: 'BUY',
          quantity: 35,
          positionSizeUsdt: 10.0,
          entryIntent: 'IMMEDIATE',
          requireApprovedQuantity: true,
        }),
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json<any>();
      expect(data.code).toBe('PRICE_BREACHED_TAKE_PROFIT');
      expect(data.error).toBe('PRICE_BREACHED_TAKE_PROFIT');
      expect(ExchangeManager.executeIdempotentOrder).not.toHaveBeenCalled();

      const storedAlerts = mockStorage.get('alerts');
      expect(storedAlerts[0].status).toBe('failed');
    });

    it('rejects execution with HTTP 409 PRICE_BREACHED_STOP_LOSS when market price breaches stop loss before SELL execution', async () => {
      const alert: TradeAlert = {
        id: 'alert_sell_sl_breach',
        symbol: 'INIT/USDT',
        signalPrice: 0.22,
        entryPrice: 0.22,
        stopLoss: 0.23,
        takeProfit: 0.20,
        estimatedPnl: 0.90,
        positionSize: 10.0,
        requestedBudget: 10.0,
        quantity: 40,
        effectiveNotional: 8.8,
        strategy: 'ScalperV2',
        side: 'SELL',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      };
      mockStorage.set('alerts', [alert]);

      // For SELL, price rising to or above SL breaches SL: 0.231 >= 0.23
      mockAdapter.fetchTicker.mockResolvedValue({ last: 0.231 });

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: 'alert_sell_sl_breach',
          symbol: 'INIT/USDT',
          side: 'SELL',
          quantity: 40,
          positionSizeUsdt: 10.0,
          entryIntent: 'IMMEDIATE',
          requireApprovedQuantity: true,
        }),
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json<any>();
      expect(data.code).toBe('PRICE_BREACHED_STOP_LOSS');
      expect(data.error).toBe('PRICE_BREACHED_STOP_LOSS');
      expect(ExchangeManager.executeIdempotentOrder).not.toHaveBeenCalled();

      const storedAlerts = mockStorage.get('alerts');
      expect(storedAlerts[0].status).toBe('failed');
    });
  });
});
