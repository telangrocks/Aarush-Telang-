import { describe, it, expect } from 'vitest';
import { RiskEngine, RiskContext } from './RiskEngine';
import { RiskParameters } from './RiskParameters';

describe('RiskEngine', () => {
  it('should calculate risk correctly for low volatility / standard risk', () => {
    const config: RiskParameters = {
      accountRiskPercent: 1, // 1% risk
      maxExposureLimit: 10, // 10% max position size
      atrStopLossMultiplier: 1.5,
      riskRewardRatio: 2.0
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

    // Take Profit Distance = 3 * 2.0 = 6
    expect(assessment.takeProfitDistance).toBe(6);

    // Risk Amount = 1% of $10,000 = $100
    // Stop Loss Percent = 3 / 100 = 0.03 (3%)
    // Position Size = $100 / 0.03 = $3,333.33
    // Max Exposure = 10% of $10,000 = $1,000
    // Since $3,333.33 > $1,000, position size is capped at $1,000
    expect(assessment.positionSizeRecommendation).toBe(1000);
    expect(assessment.maximumExposure).toBe(1000);
    expect(assessment.riskClassification).toBe('EXTREME'); // Capped by exposure
  });

  it('should calculate risk correctly for high volatility and extreme risk', () => {
    const config: RiskParameters = {
      accountRiskPercent: 5, // 5% risk
      maxExposureLimit: 50, // 50% max position size
      atrStopLossMultiplier: 2.0,
      riskRewardRatio: 1.5
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

    // Take Profit Distance = 5000 * 1.5 = 7500
    expect(assessment.takeProfitDistance).toBe(7500);

    // Risk Amount = 5% of $100k = $5000
    // Stop Loss Percent = 5000 / 50000 = 0.10 (10%)
    // Position Size = 5000 / 0.10 = 50000
    // Max Exposure = 50% of $100k = 50000
    expect(assessment.positionSizeRecommendation).toBe(50000);
    expect(assessment.riskClassification).toBe('EXTREME'); 
  });

  it('should classify as LOW risk for conservative parameters', () => {
    const config: RiskParameters = {
      accountRiskPercent: 0.5, 
      maxExposureLimit: 10,
      atrStopLossMultiplier: 2.0,
      riskRewardRatio: 3.0
    };

    const engine = new RiskEngine(config);

    const context: RiskContext = {
      timestamp: Date.now(),
      currentPrice: 100, 
      currentAtr: 5, 
      accountBalance: 10000
    };

    const assessment = engine.evaluate(context);

    // Risk Amount = 0.5% of 10000 = 50
    // Stop Loss = 5 * 2.0 = 10
    // Stop Loss Percent = 10 / 100 = 0.10
    // Position size = 50 / 0.10 = 500
    // Max exposure = 10% of 10000 = 1000
    // 500 < 1000 * 0.9 (900), so not EXTREME
    // Risk% is 0.5, which is < 2, so LOW
    expect(assessment.positionSizeRecommendation).toBe(500);
    expect(assessment.riskClassification).toBe('LOW');
  });
});
