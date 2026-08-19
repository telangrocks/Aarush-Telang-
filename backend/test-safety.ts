import { FinalDispatchSafetyGate } from './src/engine/safety/FinalDispatchSafetyGate';
import { ReconciliationEngine } from './src/engine/reconciliation/ReconciliationEngine';
import { EconomicIntent } from './src/engine/wal/WalTypes';
import BigNumber from 'bignumber.js';
import { UnifiedError } from './src/exchanges/models/UnifiedError';

async function runTests() {
  console.log("--- Running Adversarial Tests ---");
  let passed = 0;
  let total = 0;

  function assertThrows(fn: () => void, errorString: string, testName: string) {
    total++;
    try {
      fn();
      console.error(`❌ [FAILED] ${testName}: Expected throw`);
    } catch (e: any) {
      if (e.message.includes(errorString)) {
        console.log(`✅ [PASSED] ${testName}`);
        passed++;
      } else {
        console.error(`❌ [FAILED] ${testName}: Expected '${errorString}' but got '${e.message}'`);
      }
    }
  }

  // 1. Final Payload Validation Failure
  assertThrows(() => {
    FinalDispatchSafetyGate.validate(
      { amount: new BigNumber('0.001'), symbol: 'BTCUSDT', type: 'limit', side: 'buy', price: new BigNumber('50000') },
      { minQty: 0.01, stepSize: 0.001, tickSize: 0.1, minNotional: 5 }
    );
  }, 'below minimum', 'Final payload validation: Min Qty Rejection');

  assertThrows(() => {
    FinalDispatchSafetyGate.validate(
      { amount: new BigNumber('0.0155'), symbol: 'BTCUSDT', type: 'limit', side: 'buy', price: new BigNumber('50000') },
      { minQty: 0.01, stepSize: 0.01, tickSize: 0.1, minNotional: 5 }
    );
  }, 'violates stepSize precision', 'Final payload validation: Step Size Rejection');

  // 2. Mock Adapter for Reconciliation
  const mockAdapter: any = {
    fetchOrder: async () => { throw new UnifiedError('not found', 'EXCHANGE_NOT_REACHABLE') },
    fetchClosedOrders: async () => [{ clientOrderId: 'test-uuid-1', status: 'closed' }],
    fetchPositions: async () => []
  };

  const intent: EconomicIntent = {
    intentId: 'test-uuid-1',
    version: 1,
    symbol: 'BTCUSDT',
    side: 'buy',
    orderType: 'market',
    qty: '1',
    status: 'UNKNOWN',
    createdAt: Date.now() - 1000,
    reconciliationAttemptCount: 0
  };

  total++;
  const reconciled = await ReconciliationEngine.reconcile(mockAdapter, intent, Date.now());
  if (reconciled.status === 'FILLED') {
    console.log(`✅ [PASSED] Realtime NOT FOUND → history FOUND cascade`);
    passed++;
  } else {
    console.error(`❌ [FAILED] Realtime NOT FOUND → history FOUND cascade. Status: ${reconciled.status}`);
  }

  // 3. 5xx during reconciliation
  const mockAdapter5xx: any = {
    fetchOrder: async () => { throw new Error('502 Bad Gateway') },
    fetchClosedOrders: async () => [],
    fetchPositions: async () => []
  };
  
  intent.status = 'UNKNOWN';
  total++;
  const reconciled5xx = await ReconciliationEngine.reconcile(mockAdapter5xx, intent, Date.now());
  if (reconciled5xx.status === 'UNKNOWN') {
    console.log(`✅ [PASSED] 5xx/429 during reconciliation (status remains UNKNOWN, clock pauses)`);
    passed++;
  } else {
    console.error(`❌ [FAILED] 5xx/429 during reconciliation. Status: ${reconciled5xx.status}`);
  }

  console.log(`\nResults: ${passed}/${total} passed.`);
}

runTests().catch(console.error);
