import { describe, it, expect, vi, beforeEach } from 'vitest';
import BigNumber from 'bignumber.js';
import { TradingBot } from '../../src/trading-bot';
import { ExchangeManager } from '../../src/exchanges';

vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('mock_decrypted_secret'),
  encrypt: vi.fn().mockResolvedValue({ iv: 'iv', encrypted: 'enc', salt: 'salt' }),
  cleanCredential: vi.fn().mockImplementation((k) => k)
}));

describe('Forensic Investigation: Trade Confirmation Flow', () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockDb: any;
  let mockEnv: any;
  let capturedBybitOrder: any;

  beforeEach(() => {
    mockStorage = new Map<string, any>();
    capturedBybitOrder = null;

    mockState = {
      storage: {
        get: vi.fn().mockImplementation(async (key: string) => mockStorage.get(key)),
        put: vi.fn().mockImplementation(async (key: string, val: any) => {
          mockStorage.set(key, val);
        }),
        delete: vi.fn().mockImplementation(async (key: string) => {
          mockStorage.delete(key);
        }),
        list: vi.fn().mockImplementation(async (options?: any) => {
          const prefix = options?.prefix || '';
          const result = new Map();
          for (const [k, v] of mockStorage.entries()) {
            if (k.startsWith(prefix)) result.set(k, v);
          }
          return result;
        }),
        transaction: vi.fn().mockImplementation(async (closure: any) => {
          await closure({
            get: async (k: string) => mockStorage.get(k),
            put: async (k: string, v: any) => mockStorage.set(k, v),
            delete: async (k: string) => mockStorage.delete(k)
          });
        })
      },
      blockConcurrencyWhile: vi.fn().mockImplementation(async (fn: any) => fn())
    };

    mockDb = {
      prepare: vi.fn().mockImplementation((query: string) => {
        if (query.includes("PRAGMA table_info('trade_positions')")) {
          return {
            all: vi.fn().mockResolvedValue({
              results: [
                { name: 'target_entry_price' },
                { name: 'entry_status' }
              ]
            })
          };
        }
        return {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ success: true }),
            first: vi.fn().mockImplementation(async () => {
              if (query.includes('FROM users')) {
                return {
                  exchange_name: 'bybit',
                  exchange_environment: 'demo',
                  exchange_region: 'global',
                  exchange_api_key: 'test_key',
                  exchange_api_secret_encrypted: 'mock_encrypted_secret',
                  exchange_api_secret_iv: 'mock_iv',
                  exchange_api_secret_salt: 'mock_salt'
                };
              }
              if (query.includes('FROM trade_positions')) {
                return {
                  id: 'alert_soph_001',
                  user_id: 'user_test_1',
                  symbol: 'SOPH/USDT',
                  side: 'BUY',
                  entry_price: 0.005969,
                  target_entry_price: 0.005969,
                  average_fill_price: 0.005971, // Live fill price with slippage
                  quantity: 4180,
                  filled_quantity: 4180,
                  stopLoss: 0.005748,
                  takeProfit: 0.006411,
                  stop_loss: 0.005748,
                  take_profit: 0.006411,
                  status: 'OPEN',
                  entry_status: 'FILLED',
                  exchange: 'bybit',
                  environment: 'mainnet',
                  strategy: 'ScalperV2',
                  order_id: 'bybit_ord_12345'
                };
              }
              return null;
            })
          })
        };
      })
    };

    mockEnv = {
      DB: mockDb,
      ENCRYPTION_KEY: 'test_encryption_key',
      GLOBAL_TRADING_HALT: 'false'
    };

    // Mock Bybit Adapter
    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
      fetchTicker: vi.fn().mockResolvedValue({ last: 0.005969 }),
      fetchMarkets: vi.fn().mockResolvedValue([
        {
          id: 'SOPHUSDT',
          symbol: 'SOPH/USDT',
          base: 'SOPH',
          quote: 'USDT',
          category: 'linear',
          contractType: 'LinearPerpetual',
          precision: { price: 0.000001, amount: 10 },
          limits: {
            price: { min: new BigNumber(0.000001), max: new BigNumber(19.999998) },
            amount: { min: new BigNumber(10), max: new BigNumber(16500000) },
            cost: { min: new BigNumber(5) }
          },
          priceLimitRatioX: 0.1,
          priceLimitRatioY: 0.2
        }
      ]),
      createOrder: vi.fn().mockImplementation(async (req: any) => {
        capturedBybitOrder = req;
        return {
          id: 'bybit_ord_12345',
          symbol: req.symbol,
          amount: req.amount,
          status: 'open'
        };
      })
    } as any);

    vi.spyOn(ExchangeManager, 'executeIdempotentOrder').mockImplementation(async (provider: any, req: any) => {
      return provider.createOrder(req);
    });
  });

  // =========================================================================
  // Section 1: Complete End-to-End Trade Confirmation Trace
  // =========================================================================
  it('Traces: Trade Detected -> User Confirmation -> Validation -> Final Bybit Order -> Status Polling', async () => {
    const bot = new TradingBot(mockState, mockEnv);

    // Initial state: Bot configured for user
    mockStorage.set('userId', 'user_test_1');
    mockStorage.set('strategy', 'ScalperV2');

    // 1. Trade Detected: Alert generated by backend
    const alertId = 'alert_soph_001';
    const tradeAlert = {
      id: alertId,
      symbol: 'SOPH/USDT',
      strategy: 'ScalperV2',
      side: 'BUY' as const,
      targetEntryPrice: 0.005969,
      entryIntent: 'IMMEDIATE',
      entryPrice: 0.005969,
      signalPrice: 0.005969,
      stopLoss: 0.005748,
      takeProfit: 0.006411,
      positionSize: 25.00, // 25 USDT allocation
      estimatedPnl: 1.85,
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    // Register alert in Durable Object storage
    const regReq = new Request('http://bot/register-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alert: tradeAlert })
    });
    const regRes = await bot.fetch(regReq);
    expect(regRes.status).toBe(200);

    // Verification 1: Trade Detected screen values
    expect(tradeAlert.entryPrice).toBe(0.005969);
    expect(tradeAlert.stopLoss).toBe(0.005748);
    expect(tradeAlert.takeProfit).toBe(0.006411);
    expect(tradeAlert.positionSize).toBe(25.00);
    expect(tradeAlert.estimatedPnl).toBe(1.85);

    // 2. User presses "TRADE" (Trade Confirmation action)
    // Android sends confirmation request with alertId
    const execReq = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertId })
    });

    const execRes = await bot.fetch(execReq);
    expect(execRes.status).toBe(200);
    const execData = await execRes.json<any>();

    expect(execData.success).toBe(true);
    expect(execData.orderId).toBe('bybit_ord_12345');

    // 3. Verify Final Bybit Order Request constructed by backend
    expect(capturedBybitOrder).not.toBeNull();
    expect(capturedBybitOrder.symbol).toBe('SOPH/USDT');
    expect(capturedBybitOrder.side).toBe('buy');
    expect(capturedBybitOrder.type).toBe('market');
    expect(capturedBybitOrder.amount.toString()).toBe('4180'); // Quantized quantity!
    expect(capturedBybitOrder.clientOrderId).toBe(alertId);
    expect(capturedBybitOrder.stopLoss).toBe(0.005748); // Unchanged!
    expect(capturedBybitOrder.takeProfit).toBe(0.006411); // Unchanged!

    // 4. Android polls /execution-status
    const statusReq = new Request(`http://bot/execution-status?positionId=${alertId}`, {
      method: 'GET'
    });
    const statusRes = await bot.fetch(statusReq);
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json<any>();

    // 5. Verify values returned to TradeExecutionConfirmationCard
    expect(statusData.symbol).toBe('SOPH/USDT');
    expect(statusData.side).toBe('BUY');
    expect(statusData.targetEntryPrice).toBe(0.005969); // Requested Entry
    expect(statusData.actualFillPrice).toBe(0.005971);  // Actual Fill Price (from exchange)
    expect(statusData.filledQuantity).toBe(4180);       // Filled Quantity
    expect(statusData.stopLoss).toBe(0.005748);         // Stop Loss
    expect(statusData.takeProfit).toBe(0.006411);       // Take Profit
    expect(statusData.orderId).toBe('bybit_ord_12345');
    expect(statusData.isFilled).toBe(true);
  });

  // =========================================================================
  // Section 2: User Cancellation Safety
  // =========================================================================
  it('Proves user cancellation does NOT trigger any order or call to Bybit', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user_test_1');

    const alertId = 'alert_cancelled_001';
    const tradeAlert = {
      id: alertId,
      symbol: 'SOPH/USDT',
      strategy: 'ScalperV2',
      side: 'BUY' as const,
      entryPrice: 0.005969,
      stopLoss: 0.005748,
      takeProfit: 0.006411,
      positionSize: 25.00,
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    // Alert registered
    await bot.fetch(new Request('http://bot/register-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alert: tradeAlert })
    }));

    // User presses "CANCEL" -> Android sends /acknowledge to dismiss
    const ackReq = new Request('http://bot/acknowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertId })
    });
    const ackRes = await bot.fetch(ackReq);
    expect(ackRes.status).toBe(200);

    // Verify: No order was dispatched to Bybit
    expect(capturedBybitOrder).toBeNull();

    // Verify: Alert is pruned from pending list because it was acknowledged
    const pendingAlertsRes = await bot.fetch(new Request('http://bot/alerts', { method: 'GET' }));
    const pendingAlerts = await pendingAlertsRes.json<any[]>();
    expect(pendingAlerts.find((a: any) => a.id === alertId)).toBeUndefined();
  });

  // =========================================================================
  // Section 3: Duplicate Confirmation / Idempotency Protection
  // =========================================================================
  it('Proves repeated confirmation attempts return idempotent success and block duplicate orders', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user_test_1');
    mockStorage.set('strategy', 'ScalperV2');

    const alertId = 'alert_idempotent_001';
    const tradeAlert = {
      id: alertId,
      symbol: 'SOPH/USDT',
      strategy: 'ScalperV2',
      side: 'BUY' as const,
      entryIntent: 'IMMEDIATE',
      entryPrice: 0.005969,
      stopLoss: 0.005748,
      takeProfit: 0.006411,
      positionSize: 25.00,
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    await bot.fetch(new Request('http://bot/register-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alert: tradeAlert })
    }));

    // First confirmation press: succeeds
    const firstExecRes = await bot.fetch(new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertId })
    }));
    expect(firstExecRes.status).toBe(200);

    // Reset captured order tracker
    capturedBybitOrder = null;

    // Second confirmation press (rapid duplicate tap):
    const secondExecRes = await bot.fetch(new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertId })
    }));

    // Must return 200 idempotent response without creating a second Bybit order
    expect(secondExecRes.status).toBe(200);
    const secondData = await secondExecRes.json<any>();
    expect(secondData.message).toBe('Execution already handled.');
    expect(capturedBybitOrder).toBeNull(); // ZERO duplicate order sent to Bybit!
  });
});
