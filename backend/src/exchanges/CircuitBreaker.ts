export class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  
  // Configuration
  private readonly maxFailures: number;
  private readonly resetTimeoutMs: number;

  constructor(maxFailures = 5, resetTimeoutMs = 60000) {
    this.maxFailures = maxFailures;
    this.resetTimeoutMs = resetTimeoutMs;
  }

  public recordSuccess() {
    if (this.state === 'OPEN') {
      return; // Ignore delayed successes if we've already tripped
    }
    this.failures = 0;
    this.state = 'CLOSED';
  }

  public recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.maxFailures) {
      this.state = 'OPEN';
    }
  }

  public check(): { allowed: boolean; state: string } {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.lastFailure > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        return { allowed: true, state: 'HALF_OPEN' };
      }
      return { allowed: false, state: 'OPEN' };
    }
    return { allowed: true, state: this.state };
  }

  public getStatus() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure,
    };
  }
}
