import { describe, it, expect } from 'vitest';
import { ValidationPipeline } from './ValidationPipeline';
import { ValidationContext } from './ValidationContext';

describe('Milestone 7 — ValidationPipeline Framework Unit Tests', () => {
  it('ValidationPipeline runs full standard validation sequence successfully for valid order', () => {
    const pipeline = new ValidationPipeline(false);
    const ctx = new ValidationContext({
      intent: {
        userId: 'u1',
        exchangeId: 'binance',
        environment: 'mainnet',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 50000,
        quantity: 0.1,
      },
      marketRules: {
        symbol: 'BTC/USDT',
        tickSize: 0.1,
        stepSize: 0.001,
        minNotional: 10,
      },
      accountBalanceUsdt: 10000,
    });

    const res = pipeline.execute(ctx);
    expect(res.isSuccess).toBe(true);
    if (res.isSuccess) {
      expect(res.value.passedValidators.length).toBeGreaterThanOrEqual(14);
    }
  });

  it('ValidationPipeline fails fast when structural intent is invalid', () => {
    const pipeline = new ValidationPipeline(true);
    const ctx = new ValidationContext({
      intent: {
        userId: 'u1',
        exchangeId: 'binance',
        environment: 'mainnet',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 0, // Missing limit price
      },
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      expect(res.error.message).toContain('OrderIntentValidator');
    }
  });
});
