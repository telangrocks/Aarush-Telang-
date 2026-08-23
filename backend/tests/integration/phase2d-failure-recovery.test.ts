import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReconciliationEngine } from "../../src/engine/reconciliation/ReconciliationEngine";
import { EconomicIntent } from "../../src/engine/wal/WalTypes";
import BigNumber from "bignumber.js";
import { UnifiedError } from "../../src/exchanges/models/UnifiedError";

describe("Phase 2D — Failure Recovery & REST Reconciliation Sweep Tests", () => {
  let mockAdapter: any;
  let capturedCreateOrderCalls: any[];

  beforeEach(() => {
    capturedCreateOrderCalls = [];
    mockAdapter = {
      fetchOrder: vi.fn(),
      fetchClosedOrders: vi.fn(),
      fetchPositions: vi.fn(),
      fetchClosedPnl: vi.fn(),
      createOrder: vi.fn().mockImplementation((req: any) => {
        capturedCreateOrderCalls.push(req);
        return Promise.resolve({ id: "ord_123" });
      }),
    };
  });

  it("1. Timeout before Bybit receives request: recovers to UNKNOWN and then ORDER_NOT_FOUND after exhaustive window", async () => {
    const alertId = "c3cbe99c-timeout-1";
    const intent: EconomicIntent = {
      intentId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      orderType: "market",
      qty: "85.6604",
      status: "UNKNOWN",
      createdAt: Date.now() - 20 * 60 * 1000, // 20 mins ago (exceeds 15m window)
      reconciliationAttemptCount: 4, // Max attempts reached
      payloadSnapshot: {}
    };

    // Bybit returns null for order
    mockAdapter.fetchOrder.mockResolvedValue(null);
    mockAdapter.fetchClosedOrders.mockResolvedValue([]);

    const result = await ReconciliationEngine.reconcile(mockAdapter, intent, Date.now());

    expect(result.status).toBe("ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION");
    // Verify NO duplicate order was submitted
    expect(capturedCreateOrderCalls.length).toBe(0);
  });

  it("2. Timeout after Bybit accepts request: recovers existing open order via orderLinkId without resubmitting", async () => {
    const alertId = "c3cbe99c-timeout-2";
    const intent: EconomicIntent = {
      intentId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      orderType: "limit",
      qty: "85.6604",
      status: "UNKNOWN",
      createdAt: Date.now(),
      reconciliationAttemptCount: 0,
      payloadSnapshot: {}
    };

    // Bybit confirms order exists and is OPEN in orderbook
    mockAdapter.fetchOrder.mockResolvedValue({
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
    });

    const result = await ReconciliationEngine.reconcile(mockAdapter, intent, Date.now());

    expect(result.status).toBe("DISPATCHED");
    expect(result.actualOrderId).toBe("bybit_ord_5544");
    expect(capturedCreateOrderCalls.length).toBe(0);
  });

  it("3. Timeout after Bybit fills request: recovers existing filled order with authoritative avgPrice", async () => {
    const alertId = "c3cbe99c-timeout-3";
    const intent: EconomicIntent = {
      intentId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      orderType: "market",
      qty: "85.6604",
      status: "UNKNOWN",
      createdAt: Date.now(),
      reconciliationAttemptCount: 0,
      payloadSnapshot: {}
    };

    // Bybit confirms order was filled
    mockAdapter.fetchOrder.mockResolvedValue({
      id: "bybit_ord_9988",
      clientOrderId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      type: "market",
      status: "closed", // Filled
      average: new BigNumber(1.1674),
      amount: new BigNumber(85.6604),
      filled: new BigNumber(85.6604),
      remaining: new BigNumber(0),
    });

    const result = await ReconciliationEngine.reconcile(mockAdapter, intent, Date.now());

    expect(result.status).toBe("FILLED");
    expect(result.actualOrderId).toBe("bybit_ord_9988");
    expect(result.actualFillPrice).toBe("1.1674");
    expect(result.actualExecutedQuantity).toBe("85.6604");
    expect(capturedCreateOrderCalls.length).toBe(0);
  });

  it("4. Recovers existing cancelled or rejected order to FAILED", async () => {
    const alertId = "c3cbe99c-cancel-1";
    const intent: EconomicIntent = {
      intentId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      orderType: "limit",
      qty: "85.6604",
      status: "UNKNOWN",
      createdAt: Date.now(),
      reconciliationAttemptCount: 0,
      payloadSnapshot: {}
    };

    mockAdapter.fetchOrder.mockResolvedValue({
      id: "bybit_ord_cancel",
      clientOrderId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      type: "limit",
      status: "canceled",
      amount: new BigNumber(85.6604),
      filled: new BigNumber(0),
      remaining: new BigNumber(85.6604),
    });

    const result = await ReconciliationEngine.reconcile(mockAdapter, intent, Date.now());

    expect(result.status).toBe("FAILED");
    expect(capturedCreateOrderCalls.length).toBe(0);
  });

  it("5. Recovers partial fill state accurately", async () => {
    const alertId = "c3cbe99c-partial-1";
    const intent: EconomicIntent = {
      intentId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      orderType: "limit",
      qty: "100.0",
      status: "DISPATCHED",
      createdAt: Date.now(),
      reconciliationAttemptCount: 0,
      payloadSnapshot: {}
    };

    mockAdapter.fetchOrder.mockResolvedValue({
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
    });

    const result = await ReconciliationEngine.reconcile(mockAdapter, intent, Date.now());

    expect(result.status).toBe("PARTIALLY_FILLED");
    expect(result.actualExecutedQuantity).toBe("45");
    expect(result.actualFillPrice).toBe("1.1674");
  });

  it("6. Position lifecycle recovery: recovers CLOSED position with authoritative closed P&L", async () => {
    const dbPos = {
      id: "pos_123",
      symbol: "ZRO/USDT",
      side: "BUY",
      take_profit: 1.20242,
      stop_loss: 1.14989,
      status: "OPEN",
      category: "linear"
    };

    mockAdapter.fetchPositions.mockResolvedValue([]); // Position closed
    mockAdapter.fetchClosedPnl.mockResolvedValue([
      {
        symbol: "ZRO/USDT",
        orderId: "exit_tp_123",
        side: "sell",
        orderType: "Market",
        execType: "Trade",
        closedPnl: 3.50,
        avgEntryPrice: 1.1674,
        avgExitPrice: 1.20242,
        updatedTime: 1787468000000
      }
    ]);

    const result = await ReconciliationEngine.reconcilePositionLifecycle(mockAdapter, dbPos, Date.now());

    expect(result).not.toBeNull();
    expect(result?.status).toBe("CLOSED");
    expect(result?.closePrice).toBe(1.20242);
    expect(result?.realizedPnl).toBe(3.50);
    expect(result?.closeReason).toBe("take_profit");
  });

  it("7. Duplicate & out-of-order reconciliation: rejects regressions and preserves terminal states", async () => {
    const alertId = "c3cbe99c-monotonic";
    const terminalIntent: EconomicIntent = {
      intentId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      status: "FILLED",
      actualFillPrice: "1.1674",
      actualExecutedQuantity: "85.6604",
      createdAt: Date.now(),
      reconciliationAttemptCount: 1,
      payloadSnapshot: {}
    };

    // Reconciling an already FILLED intent with an out-of-order 'open' response
    mockAdapter.fetchOrder.mockResolvedValue({
      id: "bybit_ord_stale",
      clientOrderId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      status: "open", // Stale state
      amount: new BigNumber(85.6604),
      filled: new BigNumber(0),
    });

    const result = await ReconciliationEngine.reconcile(mockAdapter, terminalIntent, Date.now());

    // Monotonic progression rule keeps it FILLED
    expect(result.status).toBe("FILLED");
    expect(result.actualFillPrice).toBe("1.1674");
  });
});
