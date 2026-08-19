import { describe, it, expect } from 'vitest';
import { ReconciliationEngine } from '../../../src/engine/reconciliation/ReconciliationEngine';

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
    const createIntent = (price: string | null) => ({
      intentId: 'intent-1',
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
});
