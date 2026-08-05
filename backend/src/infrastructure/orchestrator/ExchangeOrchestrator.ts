import { BaseExchangeAdapter } from '../exchange/adapters/BaseExchangeAdapter';
import { CircuitBreaker } from './CircuitBreaker';
import { RateLimiter } from './RateLimiter';
import { RetryPolicy } from './RetryPolicy';
import { TelemetryTracer, MetricsCollector } from '../telemetry/Telemetry';
import { Result, ok, fail, createDomainError, DomainError } from '../../domain/types/Result';
import { ValidationPipeline } from '../safety/ValidationPipeline';
import { ValidationContext } from '../safety/ValidationContext';
import { SafetyTelemetry } from '../safety/SafetyTelemetry';

export class ExchangeOrchestrator {
  private circuitBreaker = new CircuitBreaker();
  private rateLimiter = new RateLimiter();
  private retryPolicy = new RetryPolicy();

  public async validateAndExecuteOrder<T>(
    pipeline: ValidationPipeline,
    context: ValidationContext,
    adapter: BaseExchangeAdapter,
    operationName: string,
    operation: (adapter: BaseExchangeAdapter) => Promise<T>,
    tracer?: TelemetryTracer
  ): Promise<Result<T, DomainError>> {
    const startTime = performance.now();
    const valRes = pipeline.execute(context);

    if (valRes.isFailure) {
      const firstFail = valRes.error;
      SafetyTelemetry.recordValidationFailure(adapter.exchangeId, {
        validatorName: 'ValidationPipeline',
        isValid: false,
        errorCode: firstFail.code,
        errorMessage: firstFail.message,
      });
      return fail(firstFail);
    }

    SafetyTelemetry.recordValidationSuccess(adapter.exchangeId, performance.now() - startTime);
    return this.execute(adapter, operationName, operation, tracer);
  }

  public async execute<T>(
    adapter: BaseExchangeAdapter,
    operationName: string,
    operation: (adapter: BaseExchangeAdapter) => Promise<T>,
    tracer?: TelemetryTracer
  ): Promise<Result<T, DomainError>> {
    const startTime = performance.now();

    // 1. Circuit Breaker Check
    if (!this.circuitBreaker.canExecute()) {
      return fail(createDomainError('CIRCUIT_OPEN', `Circuit breaker is OPEN for exchange ${adapter.exchangeId}. Request fast-rejected.`));
    }

    // 2. Rate Limiter Check
    if (!this.rateLimiter.tryConsume(1)) {
      return fail(createDomainError('RATE_LIMIT_EXCEEDED', `Rate limit exceeded for exchange ${adapter.exchangeId}.`));
    }

    try {
      // 3. Retry Pipeline Execution
      const value = await this.retryPolicy.execute(() => operation(adapter));
      this.circuitBreaker.recordSuccess();

      const durationMs = performance.now() - startTime;
      MetricsCollector.recordLatency(`orchestrator_${adapter.exchangeId}_${operationName}`, durationMs);
      MetricsCollector.increment(`orchestrator_success_${adapter.exchangeId}`, 1);

      return ok(value);
    } catch (err: any) {
      this.circuitBreaker.recordFailure();
      MetricsCollector.increment(`orchestrator_error_${adapter.exchangeId}`, 1);

      const msg = err?.message || String(err);
      if (msg.includes('region') || msg.includes('451')) {
        return fail(createDomainError('REGION_NOT_SUPPORTED', msg));
      }
      if (msg.includes('credentials') || msg.includes('401')) {
        return fail(createDomainError('AUTHENTICATION_FAILED', msg));
      }
      return fail(createDomainError('EXCHANGE_ERROR', msg));
    }
  }
}
