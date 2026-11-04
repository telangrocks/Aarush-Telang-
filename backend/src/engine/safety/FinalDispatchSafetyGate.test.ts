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

  describe('Maximum Order Quantity Gate (Check 1b) — MARKET and LIMIT across valid, invalid, and absent states', () => {
    it.each(['market', 'limit'] as const)(
      'allows %s order when amount is within or equal to valid maxQty',
      (orderType) => {
        const reqWithin: any = {
          symbol: 'SOL/USDT',
          side: 'buy',
          type: orderType,
          amount: new BigNumber(10),
          ...(orderType === 'limit' ? { price: new BigNumber(20) } : {}),
        };
        expect(() =>
          FinalDispatchSafetyGate.validate(reqWithin, {
            ...baseConstraints,
            referencePrice: 20,
            maxQty: 50,
          })
        ).not.toThrow();

        const reqBoundary: any = {
          ...reqWithin,
          amount: new BigNumber(50),
        };
        expect(() =>
          FinalDispatchSafetyGate.validate(reqBoundary, {
            ...baseConstraints,
            referencePrice: 20,
            maxQty: 50,
          })
        ).not.toThrow();
      }
    );

    it.each(['market', 'limit'] as const)(
      'rejects %s order when amount exceeds valid maxQty',
      (orderType) => {
        const req: any = {
          symbol: 'SOL/USDT',
          side: 'buy',
          type: orderType,
          amount: new BigNumber(60),
          ...(orderType === 'limit' ? { price: new BigNumber(20) } : {}),
        };
        expect(() =>
          FinalDispatchSafetyGate.validate(req, {
            ...baseConstraints,
            referencePrice: 20,
            maxQty: 50,
          })
        ).toThrow('Quantity 60 exceeds maximum 50');
      }
    );

    it.each(['market', 'limit'] as const)(
      'fails closed for %s order when maxQty is explicitly zero, negative, NaN, or Infinity',
      (orderType) => {
        const req: any = {
          symbol: 'SOL/USDT',
          side: 'buy',
          type: orderType,
          amount: new BigNumber(10),
          ...(orderType === 'limit' ? { price: new BigNumber(20) } : {}),
        };
        for (const invalidMax of [0, -10, NaN, Infinity, -Infinity]) {
          expect(() =>
            FinalDispatchSafetyGate.validate(req, {
              ...baseConstraints,
              referencePrice: 20,
              maxQty: invalidMax,
            })
          ).toThrow(`Exchange maximum order quantity (${invalidMax}) is invalid`);
        }
      }
    );

    it.each(['market', 'limit'] as const)(
      'safely allows %s order when maxQty is undefined (genuinely absent optional metadata)',
      (orderType) => {
        const req: any = {
          symbol: 'SOL/USDT',
          side: 'buy',
          type: orderType,
          amount: new BigNumber(100),
          ...(orderType === 'limit' ? { price: new BigNumber(20) } : {}),
        };
        expect(() =>
          FinalDispatchSafetyGate.validate(req, {
            ...baseConstraints,
            referencePrice: 20,
            maxQty: undefined,
          })
        ).not.toThrow();
      }
    );
  });
});
