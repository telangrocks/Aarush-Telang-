import { ValidationContext } from './ValidationContext';
import { SingleValidationStepResult } from './TradingSafetyEngine';

export function CapabilityValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'CapabilityValidator';
  const caps = context.capabilities;

  if (caps) {
    if (context.intent.leverage && context.intent.leverage > 1 && !caps.supportsFutures) {
      return {
        validatorName,
        isValid: false,
        errorCode: 'UNSUPPORTED_FUTURES_LEVERAGE',
        errorMessage: `Exchange '${context.intent.exchangeId}' does not support futures leverage.`,
      };
    }

    if (context.intent.environment === 'sandbox' && !caps.supportsSandbox) {
      return {
        validatorName,
        isValid: false,
        errorCode: 'UNSUPPORTED_SANDBOX',
        errorMessage: `Exchange '${context.intent.exchangeId}' does not support sandbox environment testing.`,
      };
    }
  }

  return { validatorName, isValid: true };
}
