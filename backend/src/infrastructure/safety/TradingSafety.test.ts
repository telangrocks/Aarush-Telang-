import { describe, it, expect } from 'vitest';
import { ValidationPipeline } from './ValidationPipeline';
import { ValidationContext } from './ValidationContext';
import { JournalRecord } from '../runtime/ExecutionJournal';

describe('Milestone 9 — Comprehensive Trading Safety & Validation Engine Test Suite', () => {
  it('Scenario 1: Reject malformed order intent (limit order missing price)', () => {
    const pipeline = new ValidationPipeline(true);
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 0 },
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      expect(res.error.message).toContain('OrderIntentValidator');
    }
  });

  it('Scenario 2: Reject tick size and step size precision violations', () => {
    const pipeline = new ValidationPipeline(true);
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000.555, quantity: 0.001 },
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.01, stepSize: 0.001 },
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      expect(res.error.message).toContain('TickSizeValidator');
    }
  });

  it('Scenario 3: Reject order below minimum notional requirement', () => {
    const pipeline = new ValidationPipeline(true);
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000, quantity: 0.0001 }, // $5
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.0001, minNotional: 10 },
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      expect(res.error.message).toContain('NotionalValidator');
    }
  });

  it('Scenario 4: Reject order exceeding account USDT balance', () => {
    const pipeline = new ValidationPipeline(true);
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 60000, quantity: 1 },
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.001, minNotional: 10 },
      accountBalanceUsdt: 500, // Insufficient for $60,000 order
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      expect(res.error.message).toContain('BalanceValidator');
    }
  });

  it('Scenario 5: Reject duplicate order execution attempts via ExecutionJournal', () => {
    const pipeline = new ValidationPipeline(true);
    const activeRecord: JournalRecord = {
      clientOrderId: 'ord_dup_attempt',
      workflowId: 'wf_active',
      intentHash: 'hash_active',
      state: 'SUBMITTING',
      payload: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000, quantity: 0.1, clientOrderId: 'ord_dup_attempt' },
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.001, minNotional: 10 },
      accountBalanceUsdt: 10000,
      journalCheckpoints: [activeRecord],
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      expect(res.error.message).toContain('DuplicateOrderValidator');
    }
  });

  it('Scenario 6: Reject all order placements when emergency kill switch is active', () => {
    const pipeline = new ValidationPipeline(true);
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000, quantity: 0.1 },
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.001, minNotional: 10 },
      accountBalanceUsdt: 10000,
      riskLimits: { isKillSwitchActive: true },
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      expect(res.error.message).toContain('KillSwitchValidator');
    }
  });

  it('Scenario 7: Full-scan mode collects all validation errors without aborting early', () => {
    const pipeline = new ValidationPipeline(false); // Fail fast disabled
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 0, quantity: 0.00001 },
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.001, minNotional: 10 },
      accountBalanceUsdt: 100,
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      // Failed intent and failed notional
      expect(res.error.message).toBeDefined();
    }
  });
});
