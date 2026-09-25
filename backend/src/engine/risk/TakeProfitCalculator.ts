import { RiskParameters } from './RiskParameters';

export class TakeProfitCalculator {
  /**
   * Model A: Take Profit Distance is calculated directly and independently from ATR.
   * TP Distance = currentAtr * atrTakeProfitMultiplier
   *
   * Note: config.riskRewardRatio is supported strictly as a legacy migration fallback
   * for persisted bot states that have not yet migrated to atrTakeProfitMultiplier.
   */
  public static calculateDistance(currentAtr: number, config: RiskParameters): number {
    const multiplier = config.atrTakeProfitMultiplier ?? config.riskRewardRatio ?? 2.0;
    return currentAtr * multiplier;
  }
}

