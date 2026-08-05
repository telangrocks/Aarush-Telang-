import { MetricsCollector, StructuredLogger } from '../telemetry/Telemetry';
import { SingleValidationStepResult } from './TradingSafetyEngine';

export class SafetyTelemetry {
  private static readonly logger = new StructuredLogger();

  public static recordValidationSuccess(exchangeId: string, durationMs: number): void {
    MetricsCollector.increment(`validation_success_${exchangeId}`, 1);
    MetricsCollector.recordLatency(`validation_latency_${exchangeId}`, durationMs);
  }

  public static recordValidationFailure(exchangeId: string, failure: SingleValidationStepResult): void {
    MetricsCollector.increment(`validation_failure_${exchangeId}`, 1);
    
    if (failure.errorCode === 'DUPLICATE_CLIENT_ORDER_ID' || failure.errorCode === 'DUPLICATE_INTENT_HASH') {
      MetricsCollector.increment('duplicate_orders_blocked', 1);
    } else if (failure.errorCode === 'INSUFFICIENT_BALANCE') {
      MetricsCollector.increment('insufficient_balance_total', 1);
    } else if (failure.errorCode?.includes('NOTIONAL')) {
      MetricsCollector.increment('invalid_notional_total', 1);
    } else if (failure.errorCode?.includes('KILL_SWITCH') || failure.errorCode?.includes('LIMIT')) {
      MetricsCollector.increment('risk_limit_rejections_total', 1);
    }

    SafetyTelemetry.logger.warn(`[SAFETY ENGINE REJECTION] Validator '${failure.validatorName}' rejected order on ${exchangeId}`, {
      validatorName: failure.validatorName,
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
    });
  }
}
