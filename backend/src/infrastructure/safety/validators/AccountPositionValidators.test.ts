import { describe, it, expect } from 'vitest';
import { BalanceValidator, LeverageValidator, PositionValidator } from './AccountPositionValidators';
import { ValidationContext } from '../ValidationContext';

describe('Milestone 4 — AccountPositionValidators Unit Tests', () => {
  it('BalanceValidator fails when balance is less than required notional', () => {
    const ctxLowBalance = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 60000, quantity: 1 }, // Notional = $60,000
      accountBalanceUsdt: 500,
    });

    const res = BalanceValidator(ctxLowBalance);
    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe('INSUFFICIENT_BALANCE');
  });

  it('LeverageValidator enforces max leverage limits', () => {
    const ctxHighLeverage = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'bybit', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', leverage: 50 },
      riskLimits: { maxLeverage: 20 },
    });

    const res = LeverageValidator(ctxHighLeverage);
    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe('EXCEEDED_MAX_LEVERAGE');
  });

  it('PositionValidator rejects reduce-only orders when no position exists', () => {
    const ctxReduceOnlyNoPos = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'ETH/USDT', side: 'sell', type: 'market', reduceOnly: true },
      openPositions: [],
    });

    const res = PositionValidator(ctxReduceOnlyNoPos);
    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe('REDUCE_ONLY_NO_POSITION');
  });
});
