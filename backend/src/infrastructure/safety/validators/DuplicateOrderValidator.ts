import { ValidationContext } from '../ValidationContext';
import { SingleValidationStepResult } from '../TradingSafetyEngine';

export function DuplicateOrderValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'DuplicateOrderValidator';
  const clientOrderId = context.intent.clientOrderId;
  const intentHash = context.intent.intentHash;
  const checkpoints = context.journalCheckpoints;

  if (clientOrderId && checkpoints && checkpoints.length > 0) {
    const matchedId = checkpoints.find((c) => c.clientOrderId === clientOrderId);
    if (matchedId) {
      return {
        validatorName,
        isValid: false,
        errorCode: 'DUPLICATE_CLIENT_ORDER_ID',
        errorMessage: `Duplicate execution attempt: Order with clientOrderId '${clientOrderId}' is already active in state '${matchedId.state}'.`,
      };
    }
  }

  if (intentHash && checkpoints && checkpoints.length > 0) {
    const matchedHash = checkpoints.find((c) => c.intentHash === intentHash);
    if (matchedHash) {
      return {
        validatorName,
        isValid: false,
        errorCode: 'DUPLICATE_INTENT_HASH',
        errorMessage: `Duplicate execution attempt: Trade intent hash '${intentHash}' is already being processed.`,
      };
    }
  }

  return { validatorName, isValid: true };
}
