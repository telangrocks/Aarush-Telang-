import { describe, it, expect } from 'vitest';
import { RiskEngine, RiskContext } from './RiskEngine';
import { RiskParameters } from './RiskParameters';

describe('RiskEngine', () => {
  it('should calculate SL and TP correctly for standard risk parameters under Model A', () => {
    const config: RiskParameters = {
      maxExposureLimit: 10, // 10% max order size
      atrStopLossMultiplier: 1.5,
      atrTakeProfitMultiplier: 2.0
    };

    const engine = new RiskEngine(config);

    const context: RiskContext = {
      timestamp: Date.now(),
      currentPrice: 100, // $100 per asset
      currentAtr: 2, // Low volatility
      accountBalance: 10000 // $10000 account
    };

    const assessment = engine.evaluate(context);

    // Stop Loss Distance = 2 * 1.5 = 3
    expect(assessment.stopLossDistance).toBe(3);

    // Take Profit Distance (Model A) = 2 * 2.0 = 4 (NOT 3 * 2.0 = 6)
    expect(assessment.takeProfitDistance).toBe(4);
    expect(assessment.maximumExposure).toBe(1000);
    // SL = 3, Price = 100 -> 3% SL distance -> LOW (< 5%)
    expect(assessment.riskClassification).toBe('LOW');
  });

  it('should calculate SL and TP correctly for high volatility parameters under Model A', () => {
    const config: RiskParameters = {
      maxExposureLimit: 50, // 50% max order size
      atrStopLossMultiplier: 2.0,
      atrTakeProfitMultiplier: 1.5
    };

    const engine = new RiskEngine(config);

    const context: RiskContext = {
      timestamp: Date.now(),
      currentPrice: 50000, // E.g. BTC
      currentAtr: 2500, // High volatility
      accountBalance: 100000 // $100k account
    };

    const assessment = engine.evaluate(context);

    // Stop Loss Distance = 2500 * 2.0 = 5000
    expect(assessment.stopLossDistance).toBe(5000);

    // Take Profit Distance (Model A) = 2500 * 1.5 = 3750 (NOT 5000 * 1.5 = 7500)
    expect(assessment.takeProfitDistance).toBe(3750);
    expect(assessment.maximumExposure).toBe(50000);
    // SL = 5000, Price = 50000 -> 10% SL distance -> HIGH (8% to < 12%)
    expect(assessment.riskClassification).toBe('HIGH');
  });

  it('should preserve legacy riskRewardRatio as fallback for older persisted configs', () => {
    const config: RiskParameters = {
      maxExposureLimit: 10,
      atrStopLossMultiplier: 2.0,
      atrTakeProfitMultiplier: undefined as any,
      riskRewardRatio: 3.0 // Legacy fallback
    };

    const engine = new RiskEngine(config);

    const context: RiskContext = {
      timestamp: Date.now(),
      currentPrice: 100,
      currentAtr: 5,
      accountBalance: 10000
    };

    const assessment = engine.evaluate(context);

    // Stop Loss = 5 * 2.0 = 10
    expect(assessment.stopLossDistance).toBe(10);
    // Take Profit (Model A with fallback) = 5 * 3.0 = 15 (NOT 10 * 3.0 = 30)
    expect(assessment.takeProfitDistance).toBe(15);
    // SL = 10, Price = 100 -> 10% SL distance -> HIGH (8% to < 12%)
    expect(assessment.riskClassification).toBe('HIGH');
  });

  it('DETERMINISTIC MODEL A AUDIT TEST: BUY (Entry 150, ATR 2, SL 1.5x, TP 2.0x, Trade Amount 9 USDT)', () => {
    const tradeAmount = 9.00;
    const entryPrice = 150.00;
    const currentAtr = 2.00;
    const slMultiplier = 1.5;
    const tpMultiplier = 2.0;

    const config: RiskParameters = {
      maxExposureLimit: 25.0,
      atrStopLossMultiplier: slMultiplier,
      atrTakeProfitMultiplier: tpMultiplier
    };

    const engine = new RiskEngine(config);
    const assessment = engine.evaluate({
      timestamp: Date.now(),
      currentPrice: entryPrice,
      currentAtr: currentAtr,
      accountBalance: 1000.0
    });

    const quantity = tradeAmount / entryPrice;
    expect(quantity).toBeCloseTo(0.06, 6);

    // SL Distance = ATR * SL multiplier = 2 * 1.5 = 3.0
    expect(assessment.stopLossDistance).toBe(3.0);
    const slPrice = entryPrice - assessment.stopLossDistance;
    expect(slPrice).toBe(147.00);

    // TP Distance (Model A) = ATR * TP multiplier = 2 * 2.0 = 4.0
    expect(assessment.takeProfitDistance).toBe(4.0);
    const tpPrice = entryPrice + assessment.takeProfitDistance;
    expect(tpPrice).toBe(154.00);

    // CRITICAL INVARIANT: TP MUST NOT be 156.00 (Model B failure prevention)
    expect(tpPrice).not.toBe(156.00);

    // Estimated P&L = |TP - Entry| * (TradeAmount / Entry) = (154 - 150) * 0.06 = +0.24 USDT
    const estimatedPnl = Math.abs(tpPrice - entryPrice) * quantity;
    expect(estimatedPnl).toBeCloseTo(0.24, 4);

    // SL = 3.0, Price = 150.0 -> 2.0% SL distance -> LOW (< 5%)
    expect(assessment.riskClassification).toBe('LOW');
  });

  it('DETERMINISTIC MODEL A AUDIT TEST: SELL (Entry 150, ATR 2, SL 1.5x, TP 2.0x, Trade Amount 9 USDT)', () => {
    const tradeAmount = 9.00;
    const entryPrice = 150.00;
    const currentAtr = 2.00;
    const slMultiplier = 1.5;
    const tpMultiplier = 2.0;

    const config: RiskParameters = {
      maxExposureLimit: 25.0,
      atrStopLossMultiplier: slMultiplier,
      atrTakeProfitMultiplier: tpMultiplier
    };

    const engine = new RiskEngine(config);
    const assessment = engine.evaluate({
      timestamp: Date.now(),
      currentPrice: entryPrice,
      currentAtr: currentAtr,
      accountBalance: 1000.0
    });

    const quantity = tradeAmount / entryPrice;
    expect(quantity).toBeCloseTo(0.06, 6);

    // SL Distance = ATR * SL multiplier = 2 * 1.5 = 3.0
    expect(assessment.stopLossDistance).toBe(3.0);
    const slPrice = entryPrice + assessment.stopLossDistance;
    expect(slPrice).toBe(153.00);

    // TP Distance (Model A) = ATR * TP multiplier = 2 * 2.0 = 4.0
    expect(assessment.takeProfitDistance).toBe(4.0);
    const tpPrice = entryPrice - assessment.takeProfitDistance;
    expect(tpPrice).toBe(146.00);

    // CRITICAL INVARIANT: TP MUST NOT be 144.00 (Model B failure prevention)
    expect(tpPrice).not.toBe(144.00);

    // Estimated P&L = |TP - Entry| * (TradeAmount / Entry) = (150 - 146) * 0.06 = +0.24 USDT
    const estimatedPnl = Math.abs(tpPrice - entryPrice) * quantity;
    expect(estimatedPnl).toBeCloseTo(0.24, 4);

    // SL = 3.0, Price = 150.0 -> 2.0% SL distance -> LOW (< 5%)
    expect(assessment.riskClassification).toBe('LOW');
  });

  describe('Dynamic Risk Classification (Approved Provisional Policy)', () => {
    const config: RiskParameters = {
      maxExposureLimit: 20.0,
      atrStopLossMultiplier: 1.0,
      atrTakeProfitMultiplier: 2.0
    };
    const engine = new RiskEngine(config);

    it('should classify trades with stop loss < 5% as LOW', () => {
      // 2% stop loss
      const res = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: 2.0, // SL distance = 2.0 (2%)
        accountBalance: 10000
      });
      expect(res.riskClassification).toBe('LOW');
      expect(res.explanation.some(e => e.includes('Risk classification is LOW'))).toBe(true);
    });

    it('should classify trades with 5% <= stop loss < 8% as MEDIUM', () => {
      // 6% stop loss
      const res = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: 6.0, // SL distance = 6.0 (6%)
        accountBalance: 10000
      });
      expect(res.riskClassification).toBe('MEDIUM');
      expect(res.explanation.some(e => e.includes('Risk classification is MEDIUM'))).toBe(true);
    });

    it('should classify trades with 8% <= stop loss < 12% as HIGH', () => {
      // 9% stop loss
      const res = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: 9.0, // SL distance = 9.0 (9%)
        accountBalance: 10000
      });
      expect(res.riskClassification).toBe('HIGH');
      expect(res.explanation.some(e => e.includes('Risk classification is HIGH'))).toBe(true);
    });

    it('should classify trades with stop loss >= 12% as EXTREME', () => {
      // 15% stop loss
      const res = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: 15.0, // SL distance = 15.0 (15%)
        accountBalance: 10000
      });
      expect(res.riskClassification).toBe('EXTREME');
      expect(res.explanation.some(e => e.includes('Risk classification is EXTREME'))).toBe(true);
    });

    it('should accurately evaluate boundary at 5.0%: 4.99% is LOW, 5.00% is MEDIUM', () => {
      const resBelow = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: 4.99,
        accountBalance: 10000
      });
      expect(resBelow.riskClassification).toBe('LOW');

      const resAt = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: 5.00,
        accountBalance: 10000
      });
      expect(resAt.riskClassification).toBe('MEDIUM');
    });

    it('should accurately evaluate boundary at 8.0%: 7.99% is MEDIUM, 8.00% is HIGH', () => {
      const resBelow = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: 7.99,
        accountBalance: 10000
      });
      expect(resBelow.riskClassification).toBe('MEDIUM');

      const resAt = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: 8.00,
        accountBalance: 10000
      });
      expect(resAt.riskClassification).toBe('HIGH');
    });

    it('should accurately evaluate boundary at 12.0%: 11.99% is HIGH, 12.00% is EXTREME', () => {
      const resBelow = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: 11.99,
        accountBalance: 10000
      });
      expect(resBelow.riskClassification).toBe('HIGH');

      const resAt = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: 12.00,
        accountBalance: 10000
      });
      expect(resAt.riskClassification).toBe('EXTREME');
    });
  });

  describe('Defensive Fail-Closed Input Validation', () => {
    const config: RiskParameters = {
      maxExposureLimit: 20.0,
      atrStopLossMultiplier: 1.5,
      atrTakeProfitMultiplier: 2.0
    };
    const engine = new RiskEngine(config);

    it('should fail closed to EXTREME with 0 position size when currentPrice <= 0', () => {
      const resZero = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 0,
        currentAtr: 2.0,
        accountBalance: 10000
      });
      expect(resZero.riskClassification).toBe('EXTREME');
      expect(resZero.positionSizeRecommendation).toBe(0);
      expect(resZero.explanation.some(e => e.includes('fail closed to EXTREME'))).toBe(true);

      const resNeg = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: -150,
        currentAtr: 2.0,
        accountBalance: 10000
      });
      expect(resNeg.riskClassification).toBe('EXTREME');
      expect(resNeg.positionSizeRecommendation).toBe(0);
    });

    it('should fail closed to EXTREME with 0 position size when currentPrice is NaN or Infinite', () => {
      const resNaN = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: NaN,
        currentAtr: 2.0,
        accountBalance: 10000
      });
      expect(resNaN.riskClassification).toBe('EXTREME');
      expect(resNaN.positionSizeRecommendation).toBe(0);

      const resInf = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: Infinity,
        currentAtr: 2.0,
        accountBalance: 10000
      });
      expect(resInf.riskClassification).toBe('EXTREME');
      expect(resInf.positionSizeRecommendation).toBe(0);
    });

    it('should fail closed to EXTREME with 0 position size when currentAtr / stopLossDistance <= 0', () => {
      const resZeroAtr = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: 0,
        accountBalance: 10000
      });
      expect(resZeroAtr.riskClassification).toBe('EXTREME');
      expect(resZeroAtr.positionSizeRecommendation).toBe(0);

      const resNegAtr = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: -2.5,
        accountBalance: 10000
      });
      expect(resNegAtr.riskClassification).toBe('EXTREME');
      expect(resNegAtr.positionSizeRecommendation).toBe(0);
    });

    it('should fail closed to EXTREME with 0 position size when currentAtr is NaN or Infinite', () => {
      const resNaNAtr = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: NaN,
        accountBalance: 10000
      });
      expect(resNaNAtr.riskClassification).toBe('EXTREME');
      expect(resNaNAtr.positionSizeRecommendation).toBe(0);

      const resInfAtr = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 100,
        currentAtr: Infinity,
        accountBalance: 10000
      });
      expect(resInfAtr.riskClassification).toBe('EXTREME');
      expect(resInfAtr.positionSizeRecommendation).toBe(0);
    });
  });

  describe('Regression: Clamped Position Sizing Does NOT Cause EXTREME Classification', () => {
    it('should correctly classify tight-stop scalps as LOW even when position size is clamped to max exposure', () => {
      const config: RiskParameters = {
        maxExposureLimit: 20.0, // 20% max allowed exposure = 2000 USDT on 10000 balance
        atrStopLossMultiplier: 1.5,
        atrTakeProfitMultiplier: 2.0,
        accountRiskPercent: 1.0 // Willing to lose 100 USDT
      };
      const engine = new RiskEngine(config);

      // Low volatility scalp on BTC:
      // Price = 60,000, ATR = 400, Multiplier = 1.5 -> SL distance = 600 (1.0% stop loss)
      // Raw position size = 100 / (600 / 60000) = 10,000 USDT
      // Clamped to max allowed exposure = 2,000 USDT (100% of max exposure)
      // Under old bug: positionSize >= 90% maxExposure -> EXTREME!
      // Under corrected logic: 1.0% stop loss < 5.0% -> LOW!
      const res = engine.evaluate({
        timestamp: Date.now(),
        currentPrice: 60000,
        currentAtr: 400,
        accountBalance: 10000
      });

      expect(res.stopLossDistance).toBe(600);
      expect(res.positionSizeRecommendation).toBe(2000); // Successfully clamped to maxExposure
      expect(res.maximumExposure).toBe(2000);
      expect(res.riskClassification).toBe('LOW'); // NOT EXTREME!
      expect(res.explanation.some(e => e.includes('Risk classification is LOW'))).toBe(true);
    });
  });
});
