import { describe, it, expect } from 'vitest';
import { FinalDispatchSafetyGate } from './FinalDispatchSafetyGate';
import BigNumber from 'bignumber.js';

describe('FinalDispatchSafetyGate Unit Tests', () => {
  const baseConstraints = {
    stepSize: 0.1,
    tickSize: 0.01,
    minQty: 0.1,
    minNotional: 5,
  };

  it('accepts compliant order with 2-decimal price, TP, and SL', () => {
    const validReq: any = {
      symbol: 'SOL/USDT',
      side: 'buy',
      type: 'limit',
      amount: new BigNumber(1.5),
      price: new BigNumber(135.50),
      takeProfit: 145.25,
      stopLoss: 130.10,
    };

    expect(() => FinalDispatchSafetyGate.validate(validReq, baseConstraints)).not.toThrow();
  });

  it('rejects order with takeProfit exceeding tickSize precision', () => {
    const invalidReq: any = {
      symbol: 'SOL/USDT',
      side: 'buy',
      type: 'market',
      amount: new BigNumber(1.5),
      takeProfit: 145.256,
      stopLoss: 130.10,
    };

    expect(() => FinalDispatchSafetyGate.validate(invalidReq, baseConstraints)).toThrow(
      'TakeProfit 145.256 violates tickSize precision 0.01'
    );
  });

  it('rejects order with stopLoss exceeding tickSize precision', () => {
    const invalidReq: any = {
      symbol: 'SOL/USDT',
      side: 'buy',
      type: 'market',
      amount: new BigNumber(1.5),
      takeProfit: 145.25,
      stopLoss: 130.105,
    };

    expect(() => FinalDispatchSafetyGate.validate(invalidReq, baseConstraints)).toThrow(
      'StopLoss 130.105 violates tickSize precision 0.01'
    );
  });

  it('rejects order with amount exceeding stepSize precision', () => {
    const invalidReq: any = {
      symbol: 'SOL/USDT',
      side: 'buy',
      type: 'market',
      amount: new BigNumber(1.55),
    };

    expect(() => FinalDispatchSafetyGate.validate(invalidReq, baseConstraints)).toThrow(
      'Quantity 1.55 violates stepSize precision 0.1'
    );
  });
});
