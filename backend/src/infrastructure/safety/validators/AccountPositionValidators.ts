import { ValidationContext } from '../ValidationContext';
import { SingleValidationStepResult } from '../TradingSafetyEngine';

export function BalanceValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'BalanceValidator';
  const price = context.intent.price || 0;
  const qty = context.intent.quantity || 0;
  const notional = context.intent.notionalUsdt || price * qty;
  const balance = context.accountBalanceUsdt;

  if (balance !== undefined && notional > 0) {
    if (balance < notional) {
      return {
        validatorName,
        isValid: false,
        errorCode: 'INSUFFICIENT_BALANCE',
        errorMessage: `Account USDT balance $${balance} is insufficient for order notional $${notional}.`,
      };
    }
  }

  return { validatorName, isValid: true };
}

export function LeverageValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'LeverageValidator';
  const requestedLeverage = context.intent.leverage;
  const maxAllowedLeverage = context.riskLimits?.maxLeverage || 125;

  if (requestedLeverage !== undefined && requestedLeverage > 0) {
    if (requestedLeverage > maxAllowedLeverage) {
      return {
        validatorName,
        isValid: false,
        errorCode: 'EXCEEDED_MAX_LEVERAGE',
        errorMessage: `Requested leverage ${requestedLeverage}x exceeds max allowed policy limit ${maxAllowedLeverage}x.`,
      };
    }
  }

  return { validatorName, isValid: true };
}

export function PositionValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'PositionValidator';
  const isReduceOnly = context.intent.reduceOnly;
  const symbol = context.intent.symbol;

  if (isReduceOnly) {
    const existingPos = context.openPositions.find((p) => p.symbol === symbol);
    if (!existingPos || existingPos.size <= 0) {
      return {
        validatorName,
        isValid: false,
        errorCode: 'REDUCE_ONLY_NO_POSITION',
        errorMessage: `Reduce-only order rejected: No active open position found for symbol '${symbol}'.`,
      };
    }
  }

  return { validatorName, isValid: true };
}
