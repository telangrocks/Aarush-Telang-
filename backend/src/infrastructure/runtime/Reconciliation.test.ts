import { describe, it, expect } from 'vitest';
import { ExecutionJournal } from './ExecutionJournal';
import { ReconciliationService } from './ReconciliationService';
import { BybitAdapter } from '../exchange/adapters/BybitAdapter';
import BigNumber from 'bignumber.js';
import { Order } from '../../exchanges/models/NormalizedDomain';

describe('Milestone 6 — ReconciliationService Order State Repair Unit Tests', () => {
  it('ReconciliationService reconciles uncompleted checkpoints against remote exchange state', async () => {
    const journal = new ExecutionJournal();
    const service = new ReconciliationService(journal);

    // Setup an uncompleted order in journal
    const clientOrdId = 'ord_recon_001';
    const hash = await journal.createIntentHash('usr1', 'BTC/USDT', 'buy', 1);
    journal.recordSubmitting(clientOrdId, 'wf_recon', hash, { symbol: 'BTC/USDT', side: 'buy' });

    // Mock exchange adapter with remote order record
    const adapter = new BybitAdapter();
    const mockOrder: Order = {
      id: 'ex_binance_777',
      clientOrderId: clientOrdId,
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      status: 'open',
      price: new BigNumber(60000),
      amount: new BigNumber(1),
      filled: new BigNumber(0),
      remaining: new BigNumber(1),
      cost: new BigNumber(60000),
      timeInForce: 'GTC',
      timestamp: Date.now(),
    };
    adapter.fetchOpenOrders = async () => [mockOrder];

    const result = await service.reconcilePendingOrders(adapter);

    expect(result.isSuccess).toBe(true);
    if (result.isSuccess) {
      expect(result.value.reconciledCount).toBe(1);
      expect(result.value.items[0].resolvedState).toBe('COMPLETED');
      expect(result.value.items[0].exchangeOrderId).toBe('ex_binance_777');
    }

    // Check journal state updated to COMMITTED
    const updated = journal.getRecord(clientOrdId);
    expect(updated?.state).toBe('COMMITTED');
  });

  it('ReconciliationService marks orders as CANCELLED_EXTERNALLY when not found on exchange', async () => {
    const journal = new ExecutionJournal();
    const service = new ReconciliationService(journal);

    const clientOrdId = 'ord_missing_999';
    const hash = await journal.createIntentHash('usr1', 'BTC/USDT', 'buy', 1);
    journal.recordSubmitting(clientOrdId, 'wf_recon', hash, { symbol: 'BTC/USDT', side: 'buy' });

    const adapter = new BybitAdapter();
    adapter.fetchOpenOrders = async () => [];
    adapter.fetchClosedOrders = async () => [];

    const result = await service.reconcilePendingOrders(adapter);

    expect(result.isSuccess).toBe(true);
    if (result.isSuccess) {
      expect(result.value.items[0].resolvedState).toBe('CANCELLED_EXTERNALLY');
    }

    const updated = journal.getRecord(clientOrdId);
    expect(updated?.state).toBe('FAILED');
  });
});
