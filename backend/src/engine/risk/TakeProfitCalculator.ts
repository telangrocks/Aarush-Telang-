import { RiskParameters } from './RiskParameters';

export class TakeProfitCalculator {
  public static calculateDistance(stopLossDistance: number, config: RiskParameters): number {
    if (config.atrTakeProfitMultiplier) {
      // If we directly define a take profit multiplier based on ATR, 
      // but usually take profit is based on Risk/Reward Ratio.
      // We'll assume the stopLossDistance is already in price units.
      // E.g., if R:R is 2.0, Take Profit Distance = 2.0 * Stop Loss Distance.
    }
    return stopLossDistance * config.riskRewardRatio;
  }
}
