import { ValidationContext } from './ValidationContext';
import { SingleValidationStepResult } from './TradingSafetyEngine';

export function KillSwitchValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'KillSwitchValidator';
  if (context.riskLimits?.isKillSwitchActive) {
    return {
      validatorName,
      isValid: false,
      errorCode: 'KILL_SWITCH_ACTIVE',
      errorMessage: 'Emergency kill-switch is currently active. All new trade submissions are blocked.',
    };
  }
  return { validatorName, isValid: true };
}

export function MaxOrderNotionalLimitValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'MaxOrderNotionalLimitValidator';
  const price = context.intent.price || 0;
  const qty = context.intent.quantity || 0;
  const notional = context.intent.notionalUsdt || price * qty;
  const maxNotional = context.riskLimits?.maxOrderNotionalUsdt;

  if (notional > 0 && maxNotional !== undefined && notional > maxNotional) {
    return {
      validatorName,
      isValid: false,
      errorCode: 'EXCEEDED_MAX_ORDER_NOTIONAL',
      errorMessage: `Order notional $${notional} exceeds policy risk limit $${maxNotional}.`,
    };
  }
  return { validatorName, isValid: true };
}

export function DailyLossLimitValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'DailyLossLimitValidator';
  const currentLoss = context.riskLimits?.currentDailyLossUsdt;
  const maxDailyLoss = context.riskLimits?.maxDailyLossUsdt;

  if (currentLoss !== undefined && maxDailyLoss !== undefined && currentLoss >= maxDailyLoss) {
    return {
      validatorName,
      isValid: false,
      errorCode: 'DAILY_LOSS_LIMIT_REACHED',
      errorMessage: `Daily loss limit of $${maxDailyLoss} reached (current loss: $${currentLoss}). Trading paused.`,
    };
  }
  return { validatorName, isValid: true };
}

export function CooldownValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'CooldownValidator';
  const lastTrade = context.riskLimits?.lastTradeTimestamp;
  const cooldownMs = context.riskLimits?.cooldownMs;

  if (lastTrade && cooldownMs && cooldownMs > 0) {
    const elapsed = Date.now() - lastTrade;
    if (elapsed < cooldownMs) {
      return {
        validatorName,
        isValid: false,
        errorCode: 'COOLDOWN_ACTIVE',
        errorMessage: `Trade submitted during cooldown period (${elapsed}ms elapsed, required ${cooldownMs}ms).`,
      };
    }
  }
  return { validatorName, isValid: true };
}
