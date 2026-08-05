import { describe, it, expect } from 'vitest';
import { OrderIntentValidator } from './OrderIntentValidator';
import { ValidationContext } from '../ValidationContext';

describe('Milestone 2 — OrderIntentValidator Structural Verification Unit Tests', () => {
  it('OrderIntentValidator passes valid limit order intent', () => {
    const ctx = new ValidationContext({
      intent: {
        userId: 'usr_1',
        exchangeId: 'binance',
        environment: 'mainnet',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 60000,
        quantity: 0.5,
      },
    });

    const res = OrderIntentValidator(ctx);
    expect(res.isValid).toBe(true);
  });

  it('OrderIntentValidator rejects limit order missing positive price', () => {
    const ctx = new ValidationContext({
      intent: {
        userId: 'usr_1',
        exchangeId: 'binance',
        environment: 'mainnet',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 0,
      },
    });

    const res = OrderIntentValidator(ctx);
    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe('MISSING_LIMIT_PRICE');
  });

  it('OrderIntentValidator rejects POST_ONLY option on market orders', () => {
    const ctx = new ValidationContext({
      intent: {
        userId: 'usr_1',
        exchangeId: 'binance',
        environment: 'mainnet',
        symbol: 'ETH/USDT',
        side: 'buy',
        type: 'market',
        postOnly: true,
      },
    });

    const res = OrderIntentValidator(ctx);
    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe('INVALID_POST_ONLY');
  });
});
