import { BaseExchangeAdapter } from '../exchange/adapters/BaseExchangeAdapter';
import { CircuitBreaker } from './CircuitBreaker';
import { RateLimiter } from './RateLimiter';
import { RetryPolicy } from './RetryPolicy';
import { TelemetryTracer, MetricsCollector } from '../telemetry/Telemetry';
import { Result, ok, fail, createDomainError, DomainError } from '../../domain/types/Result';
import { ValidationPipeline } from '../safety/ValidationPipeline';
import { ValidationContext } from '../safety/ValidationContext';
import { SafetyTelemetry } from '../safety/SafetyTelemetry';
import { ExchangeErrorClassifier } from '../../exchanges/ExchangeErrorClassifier';

export class ExchangeOrchestrator {
  // Fix EC-H1: Per-exchange isolated circuit breakers and rate limiters
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private rateLimiters = new Map<string, RateLimiter>();
  private retryPolicy = new RetryPolicy();

  private getCircuitBreaker(exchangeId: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(exchangeId);
    if (!cb) {
      cb = new CircuitBreaker();
      this.circuitBreakers.set(exchangeId, cb);
    }
    return cb;
  }

  private getRateLimiter(exchangeId: string): RateLimiter {
    let rl = this.rateLimiters.get(exchangeId);
    if (!rl) {
      rl = new RateLimiter();
      this.rateLimiters.set(exchangeId, rl);
    }
    return rl;
  }

  public async validateAndExecuteOrder<T>(
    pipeline: ValidationPipeline,
    context: ValidationContext,
    adapter: BaseExchangeAdapter,
    operationName: string,
    operation: (adapter: BaseExchangeAdapter) => Promise<T>,
    _tracer?: TelemetryTracer
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
    return this.execute(adapter, operationName, operation, _tracer);
  }

  public async execute<T>(
    adapter: BaseExchangeAdapter,
    operationName: string,
    operation: (adapter: BaseExchangeAdapter) => Promise<T>,
    _tracer?: TelemetryTracer
  ): Promise<Result<T, DomainError>> {
    const startTime = performance.now();
    const exchangeId = adapter.exchangeId;

    // Fix EC-M4: Capability check for OCO orders
    if (operationName === 'createOcoOrder' && !adapter.capabilities.supportsOco) {
      return fail(createDomainError('UNSUPPORTED_OPERATION', `OCO orders not supported on exchange ${exchangeId}`));
    }

    const circuitBreaker = this.getCircuitBreaker(exchangeId);
    const rateLimiter = this.getRateLimiter(exchangeId);

    // 1. Circuit Breaker Check
    if (!circuitBreaker.canExecute()) {
      return fail(createDomainError('CIRCUIT_OPEN', `Circuit breaker is OPEN for exchange ${exchangeId}. Request fast-rejected.`));
    }

    // 2. Rate Limiter Check
    if (!rateLimiter.tryConsume(1)) {
      return fail(createDomainError('RATE_LIMIT_EXCEEDED', `Rate limit exceeded for exchange ${exchangeId}.`));
    }

    try {
      // 3. Retry Pipeline Execution
      const value = await this.retryPolicy.execute(() => operation(adapter));
      circuitBreaker.recordSuccess();

      const durationMs = performance.now() - startTime;
      MetricsCollector.recordLatency(`orchestrator_${exchangeId}_${operationName}`, durationMs);
      MetricsCollector.increment(`orchestrator_success_${exchangeId}`, 1);

      return ok(value);
    } catch (err: unknown) {
      // Fix EC-M8: catch (err: unknown)
      circuitBreaker.recordFailure();
      MetricsCollector.increment(`orchestrator_error_${exchangeId}`, 1);

      const classified = ExchangeErrorClassifier.getInstance().classifyException(err, exchangeId);
      return fail(createDomainError(classified.code as any, classified.friendlyMessage));
    }
  }
}
