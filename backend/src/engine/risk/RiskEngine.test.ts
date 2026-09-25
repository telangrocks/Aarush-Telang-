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
    expect(assessment.riskClassification).toBe('LOW');
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
    expect(assessment.riskClassification).toBe('LOW');
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
  });
});

