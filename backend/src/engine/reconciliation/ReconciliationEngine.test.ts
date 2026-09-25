import { describe, it, expect } from 'vitest';
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
});
