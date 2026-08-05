import { describe, it, expect } from 'vitest';
import { TradingSafetyEngine } from './TradingSafetyEngine';
import { ValidationContext } from './ValidationContext';

describe('Milestone 1 — Pure TradingSafetyEngine & ValidationContext Unit Tests', () => {
  it('TradingSafetyEngine validates order intent through registered steps cleanly', () => {
    const engine = new TradingSafetyEngine(false);

    engine.registerValidator((ctx) => ({
      validatorName: 'DummyPassValidator',
      isValid: true,
    }));

    const context = new ValidationContext({
      intent: {
        userId: 'usr_1',
        exchangeId: 'binance',
        environment: 'mainnet',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 60000,
        quantity: 0.1,
      },
    });

    const result = engine.validateOrderIntent(context);
    expect(result.isSuccess).toBe(true);
    if (result.isSuccess) {
      expect(result.value.isValid).toBe(true);
      expect(result.value.passedValidators).toContain('DummyPassValidator');
    }
  });

  it('TradingSafetyEngine respects failFast option when validation step fails', () => {
    const engine = new TradingSafetyEngine(true); // Fail fast mode

    engine.registerValidator((ctx) => ({
      validatorName: 'FailStep1',
      isValid: false,
      errorMessage: 'Step 1 failed intentionally',
    }));

    engine.registerValidator((ctx) => ({
      validatorName: 'Step2NotReached',
      isValid: true,
    }));

    const context = new ValidationContext({
      intent: {
        userId: 'usr_1',
        exchangeId: 'binance',
        environment: 'mainnet',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
      },
    });

    const result = engine.validateOrderIntent(context);
    expect(result.isFailure).toBe(true);
    if (result.isFailure) {
      expect(result.error.message).toContain('FailStep1');
    }
  });
});
