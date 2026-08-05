import { describe, it, expect } from 'vitest';
import {
  SymbolValidator,
  TickSizeValidator,
  StepSizeValidator,
  MinMaxQuantityValidator,
  NotionalValidator,
} from './MarketRulesValidators';
import { ValidationContext } from '../ValidationContext';

describe('Milestone 3 — MarketRulesValidators Unit Tests', () => {
  it('SymbolValidator fails if market rules missing', () => {
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit' },
    });
    expect(SymbolValidator(ctx).isValid).toBe(false);
  });

  it('TickSizeValidator and StepSizeValidator validate modulo precision', () => {
    const ctxValid = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000.5, quantity: 0.002 },
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.001 },
    });

    expect(TickSizeValidator(ctxValid).isValid).toBe(true);
    expect(StepSizeValidator(ctxValid).isValid).toBe(true);

    const ctxInvalid = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000.55, quantity: 0.0025 },
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.001 },
    });

    expect(TickSizeValidator(ctxInvalid).isValid).toBe(false);
    expect(StepSizeValidator(ctxInvalid).isValid).toBe(false);
  });

  it('NotionalValidator enforces minNotional boundaries', () => {
    const ctxLowNotional = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000, quantity: 0.0001 }, // Notional = $5
      marketRules: { symbol: 'BTC/USDT', minNotional: 10 },
    });

    const res = NotionalValidator(ctxLowNotional);
    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe('MIN_NOTIONAL_VIOLATION');
  });
});
