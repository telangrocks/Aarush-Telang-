import { CircuitBreaker } from '../orchestrator/CircuitBreaker';
import { RetryBudget } from './RetryBudget';
import { RuntimeState, ExchangeHealthSnapshot, RecoveryReason } from './RuntimeState';

export interface HealthCheckDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly healthScore: number;
}

export class HealthMonitor {
  private breakers = new Map<string, CircuitBreaker>();
  private budgets = new Map<string, RetryBudget>();
  private state: RuntimeState = RuntimeState.createEmpty();

  public getCircuitBreaker(exchangeId: string): CircuitBreaker {
    if (!this.breakers.has(exchangeId)) {
      this.breakers.set(exchangeId, new CircuitBreaker(5, 30000));
    }
    return this.breakers.get(exchangeId)!;
  }

  public getRetryBudget(exchangeId: string): RetryBudget {
    if (!this.budgets.has(exchangeId)) {
      this.budgets.set(exchangeId, new RetryBudget(10, 1));
    }
    return this.budgets.get(exchangeId)!;
  }

  public evaluateHealth(exchangeId: string): HealthCheckDecision {
    const breaker = this.getCircuitBreaker(exchangeId);
    const budget = this.getRetryBudget(exchangeId);
    const circuitState = breaker.getState();

    let healthScore = 100;

    if (circuitState === 'OPEN') {
      healthScore = 0;
      this.updateStateSnapshot(exchangeId, healthScore, 'OPEN', 'Circuit breaker is OPEN');
      return { allowed: false, reason: 'Circuit breaker is OPEN fast-rejecting requests', healthScore: 0 };
    }

    if (circuitState === 'HALF_OPEN') {
      healthScore = 50;
    }

    const availableTokens = budget.getAvailableTokens();
    if (availableTokens < 3) {
      healthScore = Math.max(10, healthScore - 30);
    }

    this.updateStateSnapshot(exchangeId, healthScore, circuitState);

    return {
      allowed: true,
      healthScore,
    };
  }

  public recordSuccess(exchangeId: string): void {
    const breaker = this.getCircuitBreaker(exchangeId);
    breaker.recordSuccess();
    this.evaluateHealth(exchangeId);
  }

  public recordFailure(exchangeId: string, error: unknown): void {
    const breaker = this.getCircuitBreaker(exchangeId);
    const budget = this.getRetryBudget(exchangeId);

    if (budget.isRetryable(error)) {
      budget.tryAcquireRetryToken();
    }

    breaker.recordFailure();

    const msg = (error as any)?.message || String(error);
    const score = breaker.getState() === 'OPEN' ? 0 : 30;
    this.updateStateSnapshot(exchangeId, score, breaker.getState(), msg);
  }

  public getRuntimeState(): RuntimeState {
    return this.state;
  }

  private updateStateSnapshot(exchangeId: string, healthScore: number, circuitState: any, lastErrorMsg?: string): void {
    const snapshot: ExchangeHealthSnapshot = {
      exchangeId,
      healthScore,
      circuitState,
      lastErrorTime: lastErrorMsg ? Date.now() : undefined,
      lastErrorMsg,
    };
    this.state = this.state.withExchangeHealth(snapshot);
  }
}
