import { Result, ok, fail, createDomainError, DomainError } from '../../domain/types/Result';
import { ValidationContext } from './ValidationContext';

export interface SingleValidationStepResult {
  readonly validatorName: string;
  readonly isValid: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface ValidationSummary {
  readonly isValid: boolean;
  readonly context: ValidationContext;
  readonly failedValidators: SingleValidationStepResult[];
  readonly passedValidators: string[];
}

export type IOrderValidatorStep = (context: ValidationContext) => SingleValidationStepResult;

export class TradingSafetyEngine {
  private validators: IOrderValidatorStep[] = [];

  constructor(private readonly failFast: boolean = true) {}

  public registerValidator(validatorStep: IOrderValidatorStep): void {
    this.validators.push(validatorStep);
  }

  public validateOrderIntent(context: ValidationContext): Result<ValidationSummary, DomainError> {
    const failedValidators: SingleValidationStepResult[] = [];
    const passedValidators: string[] = [];

    for (const step of this.validators) {
      const stepRes = step(context);
      if (stepRes.isValid) {
        passedValidators.push(stepRes.validatorName);
      } else {
        failedValidators.push(stepRes);
        if (this.failFast) {
          break;
        }
      }
    }

    const isValid = failedValidators.length === 0;
    const summary: ValidationSummary = {
      isValid,
      context,
      failedValidators,
      passedValidators,
    };

    if (!isValid) {
      const firstFail = failedValidators[0];
      return fail(createDomainError('VALIDATION_FAILED', `Order validation failed at '${firstFail.validatorName}': ${firstFail.errorMessage}`));
    }

    return ok(summary);
  }
}
