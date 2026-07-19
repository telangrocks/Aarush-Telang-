import { RiskParameters } from './RiskParameters';

export class PositionSizing {
  /**
   * Calculates position size based on account risk and stop loss distance.
   * 
   * @param accountBalance The total account balance in quote currency.
   * @param stopLossDistance The absolute price distance from entry to stop loss.
   * @param currentPrice The current price of the asset.
   * @param config The risk configuration parameters.
   * @returns The allowed position size in quote currency.
   */
  public static calculateSize(
    accountBalance: number,
    stopLossDistance: number,
    currentPrice: number,
    config: RiskParameters
  ): number {
    if (stopLossDistance <= 0) {
      return 0; // Invalid stop loss
    }

    // Amount we are willing to lose on this trade
    const riskAmount = accountBalance * (config.accountRiskPercent / 100);

    // Stop loss percentage
    const stopLossPercent = stopLossDistance / currentPrice;

    // Position size in quote currency to risk exactly 'riskAmount'
    const positionSize = riskAmount / stopLossPercent;

    // Ensure we don't exceed max exposure limits
    const maxAllowedExposure = accountBalance * (config.maxExposureLimit / 100);

    return Math.min(positionSize, maxAllowedExposure);
  }
}
