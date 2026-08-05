import { ValidationContext } from '../ValidationContext';
import { SingleValidationStepResult } from '../TradingSafetyEngine';
import BigNumber from 'bignumber.js';

export function SymbolValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'SymbolValidator';
  if (!context.marketRules) {
    return { validatorName, isValid: false, errorCode: 'MARKET_RULES_MISSING', errorMessage: `Market metadata rules missing for symbol '${context.intent.symbol}'.` };
  }
  return { validatorName, isValid: true };
}

export function TickSizeValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'TickSizeValidator';
  const price = context.intent.price;
  const tickSize = context.marketRules?.tickSize;

  if (price !== undefined && tickSize !== undefined && tickSize > 0) {
    const remainder = new BigNumber(price).modulo(tickSize);
    if (!remainder.isZero()) {
      return { validatorName, isValid: false, errorCode: 'INVALID_TICK_SIZE', errorMessage: `Price ${price} does not align with required tick size ${tickSize}.` };
    }
  }
  return { validatorName, isValid: true };
}

export function StepSizeValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'StepSizeValidator';
  const qty = context.intent.quantity;
  const stepSize = context.marketRules?.stepSize;

  if (qty !== undefined && stepSize !== undefined && stepSize > 0) {
    const remainder = new BigNumber(qty).modulo(stepSize);
    if (!remainder.isZero()) {
      return { validatorName, isValid: false, errorCode: 'INVALID_STEP_SIZE', errorMessage: `Quantity ${qty} does not align with required step size ${stepSize}.` };
    }
  }
  return { validatorName, isValid: true };
}

export function MinMaxQuantityValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'MinMaxQuantityValidator';
  const qty = context.intent.quantity;
  const minQty = context.marketRules?.minQty;
  const maxQty = context.marketRules?.maxQty;

  if (qty !== undefined) {
    if (minQty !== undefined && qty < minQty) {
      return { validatorName, isValid: false, errorCode: 'MIN_QTY_VIOLATION', errorMessage: `Quantity ${qty} is below minimum requirement ${minQty}.` };
    }
    if (maxQty !== undefined && qty > maxQty) {
      return { validatorName, isValid: false, errorCode: 'MAX_QTY_VIOLATION', errorMessage: `Quantity ${qty} exceeds maximum limit ${maxQty}.` };
    }
  }
  return { validatorName, isValid: true };
}

export function NotionalValidator(context: ValidationContext): SingleValidationStepResult {
  const validatorName = 'NotionalValidator';
  const price = context.intent.price || 0;
  const qty = context.intent.quantity || 0;
  const computedNotional = context.intent.notionalUsdt || price * qty;
  const minNotional = context.marketRules?.minNotional;
  const maxNotional = context.marketRules?.maxNotional;

  if (computedNotional > 0) {
    if (minNotional !== undefined && computedNotional < minNotional) {
      return { validatorName, isValid: false, errorCode: 'MIN_NOTIONAL_VIOLATION', errorMessage: `Order notional $${computedNotional} is below minimum required notional $${minNotional}.` };
    }
    if (maxNotional !== undefined && computedNotional > maxNotional) {
      return { validatorName, isValid: false, errorCode: 'MAX_NOTIONAL_VIOLATION', errorMessage: `Order notional $${computedNotional} exceeds maximum allowed notional $${maxNotional}.` };
    }
  }
  return { validatorName, isValid: true };
}
