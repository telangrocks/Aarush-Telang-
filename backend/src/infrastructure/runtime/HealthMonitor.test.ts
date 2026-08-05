import { describe, it, expect } from 'vitest';
import { HealthMonitor } from './HealthMonitor';
import { RuntimeState } from './RuntimeState';

describe('Milestone 3 — HealthMonitor & RuntimeState Unit Tests', () => {
  it('HealthMonitor computes health score and respects circuit breaker status', () => {
    const monitor = new HealthMonitor();
    const initial = monitor.evaluateHealth('binance');

    expect(initial.allowed).toBe(true);
    expect(initial.healthScore).toBe(100);

    // Record failures to trip breaker
    for (let i = 0; i < 5; i++) {
      monitor.recordFailure('binance', new Error('HTTP 500 Internal Server Error'));
    }

    const decision = monitor.evaluateHealth('binance');
    expect(decision.allowed).toBe(false);
    expect(decision.healthScore).toBe(0);
    expect(decision.reason).toContain('Circuit breaker is OPEN');
  });

  it('HealthMonitor updates immutable RuntimeState snapshots', () => {
    const monitor = new HealthMonitor();
    monitor.recordSuccess('kucoin');

    const state = monitor.getRuntimeState();
    const kucoinHealth = state.exchangeHealth.get('kucoin');

    expect(kucoinHealth).toBeDefined();
    expect(kucoinHealth?.healthScore).toBe(100);
    expect(kucoinHealth?.circuitState).toBe('CLOSED');
  });
});
