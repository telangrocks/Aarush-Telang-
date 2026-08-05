import { describe, it, expect } from 'vitest';
import { DuplicateOrderValidator } from './DuplicateOrderValidator';
import { ValidationContext } from '../ValidationContext';
import { JournalRecord } from '../../runtime/ExecutionJournal';

describe('Milestone 5 — DuplicateOrderValidator Unit Tests', () => {
  it('DuplicateOrderValidator passes unique clientOrderId and intentHash', () => {
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', clientOrderId: 'ord_new_123', intentHash: 'hash_new_123' },
      journalCheckpoints: [],
    });

    const res = DuplicateOrderValidator(ctx);
    expect(res.isValid).toBe(true);
  });

  it('DuplicateOrderValidator rejects duplicate clientOrderId in active checkpoints', () => {
    const activeCheckpoint: JournalRecord = {
      clientOrderId: 'ord_dup_999',
      workflowId: 'wf_1',
      intentHash: 'hash_original',
      state: 'SUBMITTING',
      payload: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', clientOrderId: 'ord_dup_999' },
      journalCheckpoints: [activeCheckpoint],
    });

    const res = DuplicateOrderValidator(ctx);
    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe('DUPLICATE_CLIENT_ORDER_ID');
  });

  it('DuplicateOrderValidator rejects duplicate intentHash in active checkpoints', () => {
    const activeCheckpoint: JournalRecord = {
      clientOrderId: 'ord_other',
      workflowId: 'wf_1',
      intentHash: 'hash_dup_555',
      state: 'COMMITTED',
      payload: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', intentHash: 'hash_dup_555' },
      journalCheckpoints: [activeCheckpoint],
    });

    const res = DuplicateOrderValidator(ctx);
    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe('DUPLICATE_INTENT_HASH');
  });
});
