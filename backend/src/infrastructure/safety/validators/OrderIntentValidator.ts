import { ValidationContext } from '../ValidationContext';
import { SingleValidationStepResult } from '../TradingSafetyEngine';

export function OrderIntentValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'OrderIntentValidator';
  const intent = context.intent;

  if (!intent.symbol || typeof intent.symbol !== 'string') {
    return { validatorName, isValid: false, errorCode: 'INVALID_SYMBOL', errorMessage: 'Order symbol is required and must be a valid string.' };
  }

  if (intent.side !== 'buy' && intent.side !== 'sell') {
    return { validatorName, isValid: false, errorCode: 'INVALID_SIDE', errorMessage: `Order side '${intent.side}' is invalid. Must be 'buy' or 'sell'.` };
  }

  if (intent.type !== 'limit' && intent.type !== 'market' && intent.type !== 'stop_limit') {
    return { validatorName, isValid: false, errorCode: 'INVALID_TYPE', errorMessage: `Order type '${intent.type}' is invalid.` };
  }

  if (intent.type === 'limit' && (!intent.price || intent.price <= 0)) {
    return { validatorName, isValid: false, errorCode: 'MISSING_LIMIT_PRICE', errorMessage: 'Limit orders require a positive price.' };
  }

  if (intent.type === 'stop_limit' && (!intent.stopPrice || intent.stopPrice <= 0)) {
    return { validatorName, isValid: false, errorCode: 'MISSING_STOP_PRICE', errorMessage: 'Stop-limit orders require a positive stopPrice.' };
  }

  if (intent.postOnly && intent.type === 'market') {
    return { validatorName, isValid: false, errorCode: 'INVALID_POST_ONLY', errorMessage: 'POST_ONLY option is incompatible with market orders.' };
  }

  return { validatorName, isValid: true };
}
