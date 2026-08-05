import { TradingSafetyEngine, ValidationSummary, IOrderValidatorStep } from './TradingSafetyEngine';
import { ValidationContext } from './ValidationContext';
import { OrderIntentValidator } from './validators/OrderIntentValidator';
import {
  SymbolValidator,
  TickSizeValidator,
  StepSizeValidator,
  MinMaxQuantityValidator,
  NotionalValidator,
} from './validators/MarketRulesValidators';
import {
  BalanceValidator,
  LeverageValidator,
  PositionValidator,
} from './validators/AccountPositionValidators';
import { DuplicateOrderValidator } from './validators/DuplicateOrderValidator';
import {
  KillSwitchValidator,
  MaxOrderNotionalLimitValidator,
  DailyLossLimitValidator,
  CooldownValidator,
} from './TradingPolicyEngine';
import { Result, DomainError } from '../../domain/types/Result';

export class ValidationPipeline {
  private engine: TradingSafetyEngine;

  constructor(failFast: boolean = true, customValidators?: IOrderValidatorStep[]) {
    this.engine = new TradingSafetyEngine(failFast);
    this.registerStandardValidators(customValidators);
  }

  private registerStandardValidators(customValidators?: IOrderValidatorStep[]): void {
    // 1. Structural Intent
    this.engine.registerValidator(OrderIntentValidator);

    // 2. Technical Market Rules
    this.engine.registerValidator(SymbolValidator);
    this.engine.registerValidator(TickSizeValidator);
    this.engine.registerValidator(StepSizeValidator);
    this.engine.registerValidator(MinMaxQuantityValidator);
    this.engine.registerValidator(NotionalValidator);

    // 3. Account & Position Limits
    this.engine.registerValidator(BalanceValidator);
    this.engine.registerValidator(LeverageValidator);
    this.engine.registerValidator(PositionValidator);

    // 4. Duplicate & Replay Safety
    this.engine.registerValidator(DuplicateOrderValidator);

    // 5. Business Policy & Risk Limits
    this.engine.registerValidator(KillSwitchValidator);
    this.engine.registerValidator(MaxOrderNotionalLimitValidator);
    this.engine.registerValidator(DailyLossLimitValidator);
    this.engine.registerValidator(CooldownValidator);

    // 6. Optional Custom Extensions
    if (customValidators) {
      for (const v of customValidators) {
        this.engine.registerValidator(v);
      }
    }
  }

  public execute(context: ValidationContext): Result<ValidationSummary, DomainError> {
    return this.engine.validateOrderIntent(context);
  }
}
