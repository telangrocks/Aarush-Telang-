import { RiskParameters } from './RiskParameters';

export class StopLossCalculator {
  public static calculateDistance(currentAtr: number, config: RiskParameters): number {
    return currentAtr * config.atrStopLossMultiplier;
  }
}
