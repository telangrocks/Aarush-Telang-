import { describe, it, expect } from 'vitest';
import { ExecutionJournal } from './ExecutionJournal';

describe('Milestone 5 — ExecutionJournal Canonical State Unit Tests', () => {
  it('ExecutionJournal acquires and releases locks cleanly', async () => {
    const journal = new ExecutionJournal();
    const clientOrdId = 'ord_lock_123';

    expect(journal.acquireLock(clientOrdId)).toBe(true);
    expect(journal.acquireLock(clientOrdId)).toBe(false); // Second attempt blocked

    journal.releaseLock(clientOrdId);
    expect(journal.acquireLock(clientOrdId)).toBe(true); // Re-acquired
  });

  it('ExecutionJournal tracks state transitions and recovery checkpoints', async () => {
    const journal = new ExecutionJournal();
    const clientOrdId = 'ord_trade_999';
    const hash = await journal.createIntentHash('usr1', 'BTC/USDT', 'buy', 1);

    journal.recordSubmitting(clientOrdId, 'wf_1', hash, { symbol: 'BTC/USDT', side: 'buy' });
    let rec = journal.getRecord(clientOrdId);

    expect(rec?.state).toBe('SUBMITTING');

    journal.recordStateTransition(clientOrdId, 'COMMITTED', { exchangeOrderId: 'ex_123' });
    rec = journal.getRecord(clientOrdId);
    expect(rec?.state).toBe('COMMITTED');

    const pendingCheckpoints = journal.getRecoveryCheckpoints();
    expect(pendingCheckpoints).toHaveLength(1);
    expect(pendingCheckpoints[0].clientOrderId).toBe(clientOrdId);

    journal.recordStateTransition(clientOrdId, 'COMPLETED');
    expect(journal.getRecoveryCheckpoints()).toHaveLength(0); // Completed records leave checkpoint list
  });
});
