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

  it('rejects MARKET order when effective notional is below minNotional', () => {
    const marketReq: any = {
      symbol: 'SOL/USDT',
      side: 'buy',
      type: 'market',
      amount: new BigNumber(0.1),
    };

    // 0.1 * $20 = $2.00 notional, below minNotional of 5
    expect(() =>
      FinalDispatchSafetyGate.validate(marketReq, {
        ...baseConstraints,
        referencePrice: 20,
      })
    ).toThrow('Notional 2 is below minimum 5');
  });

  it('approves MARKET order when effective notional meets minNotional', () => {
    const marketReq: any = {
      symbol: 'SOL/USDT',
      side: 'buy',
      type: 'market',
      amount: new BigNumber(1.0),
    };

    // 1.0 * $20 = $20.00 notional >= minNotional 5
    expect(() =>
      FinalDispatchSafetyGate.validate(marketReq, {
        ...baseConstraints,
        referencePrice: 20,
      })
    ).not.toThrow();
  });

  it('enforces hard maximum exposure ceiling on MARKET order using referencePrice', () => {
    const marketReq: any = {
      symbol: 'SOL/USDT',
      side: 'buy',
      type: 'market',
      amount: new BigNumber(1.0),
    };

    // currentExposure: 950, orderNotional: 100 -> total 1050 > 1000 ceiling
    expect(() =>
      FinalDispatchSafetyGate.validate(marketReq, {
        ...baseConstraints,
        referencePrice: 100,
        currentExposure: 950,
        maxExposure: 1000,
      })
    ).toThrow('Order notional 100 exceeds max exposure 1000');
  });

  it('uses payload.price for LIMIT orders even if referencePrice differs', () => {
    const limitReq: any = {
      symbol: 'SOL/USDT',
      side: 'buy',
      type: 'limit',
      amount: new BigNumber(1.0),
      price: new BigNumber(40.0),
    };

    // 1.0 * 40 = 40. currentExposure: 950 + 40 = 990 <= 1000 -> passes even though referencePrice 100 would fail
    expect(() =>
      FinalDispatchSafetyGate.validate(limitReq, {
        ...baseConstraints,
        referencePrice: 100,
        currentExposure: 950,
        maxExposure: 1000,
      })
    ).not.toThrow();
  });
});
