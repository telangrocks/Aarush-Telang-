import { describe, it, expect, vi } from 'vitest';
import { ReconciliationEngine } from './ReconciliationEngine';
import BigNumber from 'bignumber.js';

describe("ReconciliationEngine Unit Tests", () => {
  it("Test J: Monotonic Reconciliation - rejects stale updates", async () => {
    const adapter: any = {
      fetchOrder: async () => ({
        status: 'open',
        filled: 0.5,
        average: 65000,
        id: 'exch-1'
      })
    };
    
    // Previous state was partially filled with 1.0 quantity
    const intent: any = {
      intentId: 'intent-1',
      symbol: 'BTC/USDT',
      status: 'PARTIALLY_FILLED',
      actualExecutedQuantity: 1.0,
      actualFillPrice: 66000,
      reconciliationAttemptCount: 0
    };

    const reconciled = await ReconciliationEngine.reconcile(adapter, intent, Date.now());
    
    // Status should not regress from PARTIALLY_FILLED to DISPATCHED
    expect(reconciled.status).toBe('PARTIALLY_FILLED');
    // Quantity should not regress from 1.0 to 0.5
    expect(reconciled.actualExecutedQuantity).toBe("1");
    // Price should be sticky and not overwrite authoritative values from stale updates
    expect(reconciled.actualFillPrice).toBe("66000");
  });

  it("Test E: Sticky Financial Values", async () => {
    const createIntent = (price: string | null): any => ({
      intentId: 'intent-1',
      version: 1,
      side: 'BUY',
      orderType: 'MARKET',
      qty: '1.0',
      createdAt: Date.now(),
      symbol: 'BTC/USDT',
      status: 'PARTIALLY_FILLED',
      actualExecutedQuantity: "1.0",
      actualFillPrice: price,
      reconciliationAttemptCount: 0
    });

    // NULL -> NULL
    let adapter: any = { fetchOrder: async () => ({ status: 'closed', average: null, filled: 1.0 }) };
    let res = await ReconciliationEngine.reconcile(adapter, createIntent(null), Date.now());
    expect(res.actualFillPrice).toBeNull();

    // 65000 -> NULL = 65000
    adapter = { fetchOrder: async () => ({ status: 'closed', average: null, filled: 1.0 }) };
    res = await ReconciliationEngine.reconcile(adapter, createIntent("65000"), Date.now());
    expect(res.actualFillPrice).toBe("65000");

    // 65000 -> 0 = 65000
    adapter = { fetchOrder: async () => ({ status: 'closed', average: 0, filled: 1.0 }) };
    res = await ReconciliationEngine.reconcile(adapter, createIntent("65000"), Date.now());
    expect(res.actualFillPrice).toBe("65000");

    // NULL -> 65000 = 65000
    adapter = { fetchOrder: async () => ({ status: 'closed', average: 65000, filled: 1.0 }) };
    res = await ReconciliationEngine.reconcile(adapter, createIntent(null), Date.now());
    expect(res.actualFillPrice).toBe("65000");
  });

  it("Exchange-Confirmed SL/TP Readback: Working Order with Attached Protection", async () => {
    const adapter: any = {
      fetchOrder: async () => ({
        id: 'ord-working-1',
        status: 'open',
        filled: 0,
        average: null,
        stopLoss: new BigNumber(58500),
        takeProfit: new BigNumber(68500)
      })
    };

    const intent: any = {
      intentId: 'intent-work-1',
      symbol: 'BTC/USDT',
      status: 'DISPATCHED',
      reconciliationAttemptCount: 0
    };

    const reconciled = await ReconciliationEngine.reconcile(adapter, intent, Date.now());
    expect(reconciled.exchangeConfirmedStopLoss).toBe("58500");
    expect(reconciled.exchangeConfirmedTakeProfit).toBe("68500");
  });

  it("Exchange-Confirmed SL/TP Readback: Filled Order with Active Position Protection", async () => {
    const adapter: any = {
      fetchOrder: async () => ({
        id: 'ord-filled-1',
        status: 'closed',
        filled: 1.0,
        average: 64000
        // No order-level SL/TP in fill history
      }),
      fetchPositions: async (symbols?: string[]) => [
        {
          symbol: 'BTC/USDT',
          side: 'buy',
          size: new BigNumber(1),
          entryPrice: new BigNumber(64000),
          stopLoss: new BigNumber(59000),
          takeProfit: new BigNumber(71000)
        }
      ]
    };

    const intent: any = {
      intentId: 'intent-fill-1',
      symbol: 'BTC/USDT',
      status: 'DISPATCHED',
      reconciliationAttemptCount: 0
    };

    const reconciled = await ReconciliationEngine.reconcile(adapter, intent, Date.now());
    expect(reconciled.status).toBe('FILLED');
    expect(reconciled.exchangeConfirmedStopLoss).toBe("59000");
    expect(reconciled.exchangeConfirmedTakeProfit).toBe("71000");
  });

  it("Exchange-Confirmed SL/TP Readback: Zero Local Fallback when exchange returns no protection", async () => {
    const adapter: any = {
      fetchOrder: async () => ({
        id: 'ord-noprotect-1',
        status: 'closed',
        filled: 1.0,
        average: 64000
      }),
      fetchPositions: async () => []
    };

    const intent: any = {
      intentId: 'intent-noprotect-1',
      symbol: 'BTC/USDT',
      status: 'DISPATCHED',
      reconciliationAttemptCount: 0
    };

    const reconciled = await ReconciliationEngine.reconcile(adapter, intent, Date.now());
    expect(reconciled.status).toBe('FILLED');
    expect(reconciled.exchangeConfirmedStopLoss).toBeUndefined();
    expect(reconciled.exchangeConfirmedTakeProfit).toBeUndefined();
  });

  describe("reconcilePositionLifecycle", () => {
    it("returns status OPEN when position is still active on exchange with size > 0", async () => {
      const adapter: any = {
        fetchPositions: async () => [
          {
            symbol: 'SOXL/USDT',
            size: new BigNumber(10),
            entryPrice: new BigNumber(25.0)
          }
        ]
      };

      const dbPosition = {
        id: 'pos-1',
        symbol: 'SOXL/USDT',
        status: 'OPEN',
        side: 'BUY'
      };

      const result = await ReconciliationEngine.reconcilePositionLifecycle(adapter, dbPosition, Date.now());
      expect(result).not.toBeNull();
      expect(result?.status).toBe('OPEN');
    });

    it("returns status CLOSED with exit price and realized PnL when position is closed on exchange", async () => {
      const adapter: any = {
        fetchPositions: async () => [],
        fetchClosedPnl: async () => [
          {
            symbol: 'SOXL/USDT',
            orderType: 'Market',
            execType: 'Trade',
            avgExitPrice: 28.5,
            closedPnl: 35.0,
            updatedTime: 1727719200000
          }
        ]
      };

      const dbPosition = {
        id: 'pos-1',
        symbol: 'SOXL/USDT',
        status: 'OPEN',
        side: 'BUY',
        take_profit: 28.5,
        stop_loss: 23.0
      };

      const result = await ReconciliationEngine.reconcilePositionLifecycle(adapter, dbPosition, Date.now());
      expect(result).not.toBeNull();
      expect(result?.status).toBe('CLOSED');
      expect(result?.closePrice).toBe(28.5);
      expect(result?.realizedPnl).toBe(35.0);
      expect(result?.closeReason).toBe('take_profit');
    });

    it("returns null for positions already CLOSED or CANCELLED (monotonic terminal state)", async () => {
      const adapter: any = { fetchPositions: async () => [] };
      const closedPos = { id: 'pos-closed', status: 'CLOSED' };
      const cancelledPos = { id: 'pos-cancelled', status: 'CANCELLED' };

      expect(await ReconciliationEngine.reconcilePositionLifecycle(adapter, closedPos, Date.now())).toBeNull();
      expect(await ReconciliationEngine.reconcilePositionLifecycle(adapter, cancelledPos, Date.now())).toBeNull();
    });
  });

  describe("Failure Recovery & Exhaustive REST Reconciliation", () => {
    it("1. Timeout before exchange receives request: recovers UNKNOWN -> ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION with zero resubmits", async () => {
      const capturedCreateOrderCalls: any[] = [];
      const mockAdapter: any = {
        fetchOrder: vi.fn().mockResolvedValue(null),
        fetchClosedOrders: vi.fn().mockResolvedValue([]),
        fetchPositions: vi.fn(),
        fetchClosedPnl: vi.fn(),
        createOrder: vi.fn().mockImplementation((req: any) => {
          capturedCreateOrderCalls.push(req);
          return Promise.resolve({ id: "ord_123" });
        }),
      };
      const intent: any = {
        intentId: "c3cbe99c-timeout-1",
        symbol: "ZRO/USDT",
        side: "buy",
        orderType: "market",
        qty: "85.6604",
        status: "UNKNOWN",
        createdAt: Date.now() - 20 * 60 * 1000,
        reconciliationAttemptCount: 4,
        payloadSnapshot: {} as any,
      };

      const result = await ReconciliationEngine.reconcile(mockAdapter, intent, Date.now());
      expect(result.status).toBe("ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION");
      expect(capturedCreateOrderCalls.length).toBe(0);
    });

    it("2. Timeout after exchange accepts request: recovers existing open order via orderLinkId without resubmitting", async () => {
      const capturedCreateOrderCalls: any[] = [];
      const alertId = "c3cbe99c-timeout-2";
      const mockAdapter: any = {
        fetchOrder: vi.fn().mockResolvedValue({
          id: "bybit_ord_5544",
          clientOrderId: alertId,
          symbol: "ZRO/USDT",
          side: "buy",
          type: "limit",
          status: "open",
          price: new BigNumber(1.1674),
          amount: new BigNumber(85.6604),
          filled: new BigNumber(0),
          remaining: new BigNumber(85.6604),
        }),
        createOrder: vi.fn().mockImplementation((req: any) => capturedCreateOrderCalls.push(req)),
      };
      const intent: any = {
        intentId: alertId,
        symbol: "ZRO/USDT",
        side: "buy",
        orderType: "limit",
        qty: "85.6604",
        status: "UNKNOWN",
        createdAt: Date.now(),
        reconciliationAttemptCount: 0,
        payloadSnapshot: {} as any,
      };

      const result = await ReconciliationEngine.reconcile(mockAdapter, intent, Date.now());
      expect(result.status).toBe("DISPATCHED");
      expect(result.actualOrderId).toBe("bybit_ord_5544");
      expect(capturedCreateOrderCalls.length).toBe(0);
    });

    it("3. Timeout after exchange fills request: recovers existing filled order with authoritative avgPrice", async () => {
      const capturedCreateOrderCalls: any[] = [];
      const alertId = "c3cbe99c-timeout-3";
      const mockAdapter: any = {
        fetchOrder: vi.fn().mockResolvedValue({
          id: "bybit_ord_9988",
          clientOrderId: alertId,
          symbol: "ZRO/USDT",
          side: "buy",
          type: "market",
          status: "closed",
          average: new BigNumber(1.1674),
          amount: new BigNumber(85.6604),
          filled: new BigNumber(85.6604),
          remaining: new BigNumber(0),
        }),
        createOrder: vi.fn().mockImplementation((req: any) => capturedCreateOrderCalls.push(req)),
      };
      const intent: any = {
        intentId: alertId,
        symbol: "ZRO/USDT",
        side: "buy",
        orderType: "market",
        qty: "85.6604",
        status: "UNKNOWN",
        createdAt: Date.now(),
        reconciliationAttemptCount: 0,
        payloadSnapshot: {} as any,
      };

      const result = await ReconciliationEngine.reconcile(mockAdapter, intent, Date.now());
      expect(result.status).toBe("FILLED");
      expect(result.actualOrderId).toBe("bybit_ord_9988");
      expect(result.actualFillPrice).toBe("1.1674");
      expect(result.actualExecutedQuantity).toBe("85.6604");
      expect(capturedCreateOrderCalls.length).toBe(0);
    });

    it("4. Recovers existing cancelled or rejected order to FAILED without resubmitting", async () => {
      const capturedCreateOrderCalls: any[] = [];
      const alertId = "c3cbe99c-cancel-1";
      const mockAdapter: any = {
        fetchOrder: vi.fn().mockResolvedValue({
          id: "bybit_ord_cancel",
          clientOrderId: alertId,
          symbol: "ZRO/USDT",
          side: "buy",
          type: "limit",
          status: "canceled",
          amount: new BigNumber(85.6604),
          filled: new BigNumber(0),
          remaining: new BigNumber(85.6604),
        }),
        createOrder: vi.fn().mockImplementation((req: any) => capturedCreateOrderCalls.push(req)),
      };
      const intent: any = {
        intentId: alertId,
        symbol: "ZRO/USDT",
        side: "buy",
        orderType: "limit",
        qty: "85.6604",
        status: "UNKNOWN",
        createdAt: Date.now(),
        reconciliationAttemptCount: 0,
        payloadSnapshot: {} as any,
      };

      const result = await ReconciliationEngine.reconcile(mockAdapter, intent, Date.now());
      expect(result.status).toBe("FAILED");
      expect(capturedCreateOrderCalls.length).toBe(0);
    });

    it("5. Recovers partial fill state accurately from DISPATCHED", async () => {
      const alertId = "c3cbe99c-partial-1";
      const mockAdapter: any = {
        fetchOrder: vi.fn().mockResolvedValue({
          id: "bybit_ord_partial",
          clientOrderId: alertId,
          symbol: "ZRO/USDT",
          side: "buy",
          type: "limit",
          status: "partially_filled",
          average: new BigNumber(1.1674),
          amount: new BigNumber(100.0),
          filled: new BigNumber(45.0),
          remaining: new BigNumber(55.0),
        }),
      };
      const intent: any = {
        intentId: alertId,
        symbol: "ZRO/USDT",
        side: "buy",
        orderType: "limit",
        qty: "100.0",
        status: "DISPATCHED",
        createdAt: Date.now(),
        reconciliationAttemptCount: 0,
        payloadSnapshot: {} as any,
      };

      const result = await ReconciliationEngine.reconcile(mockAdapter, intent, Date.now());
      expect(result.status).toBe("PARTIALLY_FILLED");
      expect(result.actualExecutedQuantity).toBe("45");
      expect(result.actualFillPrice).toBe("1.1674");
    });

    it("6. Preserves terminal FILLED state against stale out-of-order open response", async () => {
      const alertId = "c3cbe99c-monotonic";
      const mockAdapter: any = {
        fetchOrder: vi.fn().mockResolvedValue({
          id: "bybit_ord_stale",
          clientOrderId: alertId,
          symbol: "ZRO/USDT",
          side: "buy",
          status: "open",
          amount: new BigNumber(85.6604),
          filled: new BigNumber(0),
        }),
      };
      const terminalIntent: any = {
        intentId: alertId,
        symbol: "ZRO/USDT",
        side: "buy",
        status: "FILLED",
        actualFillPrice: "1.1674",
        actualExecutedQuantity: "85.6604",
        createdAt: Date.now(),
        reconciliationAttemptCount: 1,
        payloadSnapshot: {} as any,
      };

      const result = await ReconciliationEngine.reconcile(mockAdapter, terminalIntent, Date.now());
      expect(result.status).toBe("FILLED");
      expect(result.actualFillPrice).toBe("1.1674");
    });
  });
});
