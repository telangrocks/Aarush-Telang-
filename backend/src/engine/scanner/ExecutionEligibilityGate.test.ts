import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionEligibilityGate } from './ExecutionEligibilityGate';
import { MarketOpportunityScanner } from './MarketOpportunityScanner';
import { ScannerTimeframe } from './MultiTimeframeCandleStore';
import { CandleValidator } from '../../infrastructure/exchange/CandleValidator';
import { IExchangeProvider } from '../../exchanges/IExchangeProvider';
import { ICandleProvider } from '../../infrastructure/exchange/types';

function generateCandles(timeframe: ScannerTimeframe, count: number = 60, trend: 'BULL' | 'BEAR' | 'FLAT' = 'BULL') {
  const tfMs = CandleValidator.timeframeToMs(timeframe);
  const now = Date.now();
  const startTime = now - count * tfMs;

  return Array.from({ length: count }, (_, i) => {
    let base = 100;
    let step = 0;
    if (trend === 'BULL') {
      base = 100;
      step = i * 1.5;
    } else if (trend === 'BEAR') {
      base = 300;
      step = -i * 1.5;
    }

    const close = base + step;
    return {
      timestamp: startTime + i * tfMs,
      openTime: startTime + i * tfMs,
      open: close - 0.5,
      high: close + 2.0,
      low: close - 2.0,
      close: close,
      volume: 5000 + i * 50,
    };
  });
}

describe('ExecutionEligibilityGate (Unit Tests)', () => {
  describe('High-cost tickers with 5 USDT capital allocation', () => {
    it('rejects BTC/USDT with 5 USDT when minOrderQty is 0.001 at $65,000', () => {
      const result = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: 5,
        currentPrice: 65000,
        qtyStep: 0.001,
        minOrderQty: 0.001,
        minNotional: 5,
      });

      expect(result.isExecutable).toBe(false);
      expect(result.quantizedQty).toBe(0);
      expect(result.rejectionReason).toContain('Quantized qty (0) < minOrderQty (0.001)');
      expect(result.rejectionReason).toContain('requires min ~$65.00 USDT');
    });

    it('rejects ETH/USDT with 5 USDT when minOrderQty is 0.01 at $3,500', () => {
      const result = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: 5,
        currentPrice: 3500,
        qtyStep: 0.01,
        minOrderQty: 0.01,
        minNotional: 5,
      });

      expect(result.isExecutable).toBe(false);
      expect(result.quantizedQty).toBe(0);
      expect(result.rejectionReason).toContain('Quantized qty (0) < minOrderQty (0.01)');
      expect(result.rejectionReason).toContain('requires min ~$35.00 USDT');
    });
  });

  describe('Post-rounding notional shortfall edge case', () => {
    it('rejects SOL/USDT at 5 USDT when quantizedQty satisfies minOrderQty but postRoundingNotional drops below minNotional', () => {
      // At $140, 5 USDT / 140 = 0.035714... SOL
      // qtyStep = 0.01, minOrderQty = 0.01, minNotional = 5.0
      // steps = floor(0.035714 / 0.01) = 3
      // quantizedQty = 0.03 (which is >= minOrderQty of 0.01)
      // postRoundingNotional = 0.03 * 140 = 4.20 USDT < 5.0 USDT minNotional!
      const result = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: 5,
        currentPrice: 140,
        qtyStep: 0.01,
        minOrderQty: 0.01,
        minNotional: 5,
      });

      expect(result.isExecutable).toBe(false);
      expect(result.quantizedQty).toBe(0.03);
      expect(result.postRoundingNotional).toBeCloseTo(4.2, 2);
      expect(result.rejectionReason).toContain('Post-rounding notional ($4.20 USDT) < minNotional ($5.00 USDT)');
    });

    it('accepts SOL/USDT when allocation is increased to 10 USDT', () => {
      // At $140, 10 USDT / 140 = 0.071428... SOL
      // steps = floor(0.071428 / 0.01) = 7
      // quantizedQty = 0.07
      // postRoundingNotional = 0.07 * 140 = 9.80 USDT >= 5.0 USDT
      const result = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: 10,
        currentPrice: 140,
        qtyStep: 0.01,
        minOrderQty: 0.01,
        minNotional: 5,
      });

      expect(result.isExecutable).toBe(true);
      expect(result.quantizedQty).toBe(0.07);
      expect(result.postRoundingNotional).toBeCloseTo(9.8, 2);
      expect(result.rejectionReason).toBeUndefined();
    });
  });

  describe('Valid affordable tickers with 5 USDT capital allocation', () => {
    it('accepts XRP/USDT at $0.50 with 5 USDT', () => {
      // 5 / 0.50 = 10 XRP
      const result = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: 5,
        currentPrice: 0.5,
        qtyStep: 1,
        minOrderQty: 1,
        minNotional: 5,
      });

      expect(result.isExecutable).toBe(true);
      expect(result.quantizedQty).toBe(10);
      expect(result.postRoundingNotional).toBe(5);
    });

    it('accepts DOGE/USDT at $0.10 with 5 USDT', () => {
      // 5 / 0.10 = 50 DOGE
      const result = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: 5,
        currentPrice: 0.1,
        qtyStep: 10,
        minOrderQty: 10,
        minNotional: 5,
      });

      expect(result.isExecutable).toBe(true);
      expect(result.quantizedQty).toBe(50);
      expect(result.postRoundingNotional).toBe(5);
    });
  });

  describe('Dynamic capital scaling across multiple tiers', () => {
    const btcParams = { currentPrice: 65000, qtyStep: 0.001, minOrderQty: 0.001, minNotional: 5 };
    const ethParams = { currentPrice: 3500, qtyStep: 0.01, minOrderQty: 0.01, minNotional: 5 };

    it('handles 5 USDT: both BTC and ETH rejected', () => {
      expect(ExecutionEligibilityGate.evaluate({ ...btcParams, tradeAmountUsdt: 5 }).isExecutable).toBe(false);
      expect(ExecutionEligibilityGate.evaluate({ ...ethParams, tradeAmountUsdt: 5 }).isExecutable).toBe(false);
    });

    it('handles 20 USDT: both BTC and ETH still rejected (BTC needs $65, ETH needs $35)', () => {
      expect(ExecutionEligibilityGate.evaluate({ ...btcParams, tradeAmountUsdt: 20 }).isExecutable).toBe(false);
      expect(ExecutionEligibilityGate.evaluate({ ...ethParams, tradeAmountUsdt: 20 }).isExecutable).toBe(false);
    });

    it('handles 50 USDT: ETH becomes executable, BTC remains rejected', () => {
      expect(ExecutionEligibilityGate.evaluate({ ...btcParams, tradeAmountUsdt: 50 }).isExecutable).toBe(false);
      const ethResult = ExecutionEligibilityGate.evaluate({ ...ethParams, tradeAmountUsdt: 50 });
      expect(ethResult.isExecutable).toBe(true);
      expect(ethResult.quantizedQty).toBe(0.01);
      expect(ethResult.postRoundingNotional).toBeCloseTo(35.0, 2);
    });

    it('handles 100 USDT: both BTC and ETH become executable', () => {
      const btcResult = ExecutionEligibilityGate.evaluate({ ...btcParams, tradeAmountUsdt: 100 });
      expect(btcResult.isExecutable).toBe(true);
      expect(btcResult.quantizedQty).toBe(0.001);
      expect(btcResult.postRoundingNotional).toBeCloseTo(65.0, 2);

      const ethResult = ExecutionEligibilityGate.evaluate({ ...ethParams, tradeAmountUsdt: 100 });
      expect(ethResult.isExecutable).toBe(true);
      expect(ethResult.quantizedQty).toBe(0.02);
      expect(ethResult.postRoundingNotional).toBeCloseTo(70.0, 2);
    });
  });

  describe('Boundary and input validation checks', () => {
    it('rejects trade amount strictly below minNotional', () => {
      const result = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: 4.99,
        currentPrice: 1.0,
        qtyStep: 0.1,
        minOrderQty: 0.1,
        minNotional: 5.0,
      });

      expect(result.isExecutable).toBe(false);
      expect(result.rejectionReason).toContain('below exchange minNotional ($5.00 USDT)');
    });

    it('rejects zero or negative trade amount', () => {
      const zero = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: 0,
        currentPrice: 100,
        qtyStep: 1,
        minOrderQty: 1,
        minNotional: 5,
      });
      expect(zero.isExecutable).toBe(false);
      expect(zero.rejectionReason).toContain('Invalid trade amount');

      const negative = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: -10,
        currentPrice: 100,
        qtyStep: 1,
        minOrderQty: 1,
        minNotional: 5,
      });
      expect(negative.isExecutable).toBe(false);
    });

    it('rejects zero or negative current price', () => {
      const zeroPrice = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: 10,
        currentPrice: 0,
        qtyStep: 1,
        minOrderQty: 1,
        minNotional: 5,
      });
      expect(zeroPrice.isExecutable).toBe(false);
      expect(zeroPrice.rejectionReason).toContain('Invalid market price');
    });
  });
});

describe('MarketOpportunityScanner Stage 2 Execution Eligibility Integration', () => {
  let mockProvider: IExchangeProvider & ICandleProvider;
  let scanner: MarketOpportunityScanner;

  beforeEach(() => {
    mockProvider = {
      fetchMarkets: vi.fn().mockResolvedValue([]),
      fetchTickers: vi.fn().mockResolvedValue([]),
      fetchCandles: vi.fn().mockImplementation((sym: string, tf: string) => {
        return Promise.resolve(generateCandles(tf as ScannerTimeframe, 60, 'BULL'));
      }),
    } as unknown as IExchangeProvider & ICandleProvider;

    scanner = new MarketOpportunityScanner(mockProvider);
  });

  it('unconstrained mode (tradeAmountUsdt undefined): BTC/USDT passes Stage 2 as quality candidate', async () => {
    const markets = [
      {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        category: 'linear',
        limits: { cost: { min: 5 }, amount: { min: 0.001 } },
        precision: { price: 0.1, amount: 0.001 },
      },
      {
        id: 'XRPUSDT',
        symbol: 'XRP/USDT',
        base: 'XRP',
        quote: 'USDT',
        active: true,
        category: 'linear',
        limits: { cost: { min: 5 }, amount: { min: 1 } },
        precision: { price: 0.0001, amount: 1 },
      },
    ];

    const tickers = [
      {
        symbol: 'BTC/USDT',
        last: 65000,
        bid: 64999,
        ask: 65001,
        high: 66000,
        low: 64000,
        quoteVolume: 100_000_000,
      },
      {
        symbol: 'XRP/USDT',
        last: 0.5,
        bid: 0.4999,
        ask: 0.5001,
        high: 0.52,
        low: 0.48,
        quoteVolume: 50_000_000,
      },
    ];

    // Generic discovery call without tradeAmountUsdt
    const result = await scanner.scan({ markets, tickers });

    expect(result.universeSize).toBe(2);
    expect(result.eligibleCount).toBe(2);
    expect(result.qualityCount).toBe(2);
    expect(result.allQualifiedOpportunities.map(o => o.symbol)).toContain('BTC/USDT');
    expect(result.allQualifiedOpportunities.map(o => o.symbol)).toContain('XRP/USDT');
  });

  it('constrained mode (tradeAmountUsdt = 5): BTC/USDT is REJECTED in Stage 2, XRP/USDT passes', async () => {
    const markets = [
      {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        category: 'linear',
        limits: { cost: { min: 5 }, amount: { min: 0.001 } },
        precision: { price: 0.1, amount: 0.001 },
      },
      {
        id: 'XRPUSDT',
        symbol: 'XRP/USDT',
        base: 'XRP',
        quote: 'USDT',
        active: true,
        category: 'linear',
        limits: { cost: { min: 5 }, amount: { min: 1 } },
        precision: { price: 0.0001, amount: 1 },
      },
    ];

    const tickers = [
      {
        symbol: 'BTC/USDT',
        last: 65000,
        bid: 64999,
        ask: 65001,
        high: 66000,
        low: 64000,
        quoteVolume: 100_000_000,
      },
      {
        symbol: 'XRP/USDT',
        last: 0.5,
        bid: 0.4999,
        ask: 0.5001,
        high: 0.52,
        low: 0.48,
        quoteVolume: 50_000_000,
      },
    ];

    // Constrained scan for 5 USDT allocation
    const result = await scanner.scan({ markets, tickers, tradeAmountUsdt: 5 });

    expect(result.universeSize).toBe(2);
    expect(result.eligibleCount).toBe(2);
    // Both pass quality screening (turnover/spread/range)
    expect(result.qualityCount).toBe(2);
    // BTC is rejected by post-Top-25 budget gate; XRP passes
    expect(result.allQualifiedOpportunities.map(o => o.symbol)).not.toContain('BTC/USDT');
    expect(result.allQualifiedOpportunities.map(o => o.symbol)).toContain('XRP/USDT');
  });

  it('strictly enforces canonical Top-25 turnover ranking: unaffordable Top-25 markets are removed post-ranking without lower-turnover replacement', async () => {
    // Generate 30 markets:
    // First 10: high turnover ($100M down to $91M), but BTC-like (minOrderQty=0.001 at $65,000 -> requires $65)
    // Next 20: moderate turnover ($50M down to $31M), but XRP-like (price=$1, minOrderQty=1, qtyStep=1 -> requires $5)
    const markets: any[] = [];
    const tickers: any[] = [];

    for (let i = 1; i <= 10; i++) {
      markets.push({
        id: `EXPENSIVE${i}USDT`,
        symbol: `EXPENSIVE${i}/USDT`,
        base: `EXPENSIVE${i}`,
        quote: 'USDT',
        active: true,
        category: 'linear',
        limits: { cost: { min: 5 }, amount: { min: 0.001 } },
        precision: { price: 0.1, amount: 0.001 },
      });
      tickers.push({
        symbol: `EXPENSIVE${i}/USDT`,
        last: 65000,
        bid: 64995,
        ask: 65005,
        high: 66000,
        low: 64000,
        quoteVolume: 100_000_000 - i * 1_000_000,
      });
    }

    for (let i = 1; i <= 20; i++) {
      markets.push({
        id: `AFFORDABLE${i}USDT`,
        symbol: `AFFORDABLE${i}/USDT`,
        base: `AFFORDABLE${i}`,
        quote: 'USDT',
        active: true,
        category: 'linear',
        limits: { cost: { min: 5 }, amount: { min: 1 } },
        precision: { price: 0.01, amount: 1 },
      });
      tickers.push({
        symbol: `AFFORDABLE${i}/USDT`,
        last: 1.0,
        bid: 0.9999,
        ask: 1.0001,
        high: 1.05,
        low: 0.95,
        quoteVolume: 50_000_000 - i * 1_000_000,
      });
    }

    const result = await scanner.scan({ markets, tickers, tradeAmountUsdt: 5 });

    // Canonical ordering:
    // 1. All 30 pass quality screening (turnover/spread/range)
    expect(result.qualityCount).toBe(30);
    // 2. Top 25 sliced by turnover: 10 expensive (ranks 1-10) + 15 affordable (ranks 11-25)
    // 3. Post-Top-25 budget gate drops the 10 expensive markets
    // 4. Exactly 15 affordable candidates remain (AFFORDABLE 16-20 are rank 26-30 and NOT pulled in)
    expect(result.allQualifiedOpportunities.length).toBe(15);
    for (const opp of result.allQualifiedOpportunities) {
      expect(opp.symbol.startsWith('AFFORDABLE')).toBe(true);
    }
  });
});
