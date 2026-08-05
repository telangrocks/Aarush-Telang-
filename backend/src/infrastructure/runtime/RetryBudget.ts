export class RetryBudget {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number = 10,
    private readonly refillRatePerSec: number = 1
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  public isRetryable(error: unknown): boolean {
    if (!error) return false;
    const msg = String((error as any)?.message || error).toLowerCase();
    const code = (error as any)?.code;

    // Non-retryable errors (Security/Credentials/Invalid Payload/Balance)
    if (
      msg.includes('401') ||
      msg.includes('403') ||
      msg.includes('authentication') ||
      msg.includes('credentials') ||
      msg.includes('invalid_symbol') ||
      msg.includes('insufficient funds') ||
      msg.includes('insufficient_funds') ||
      msg.includes('unsupported_operation') ||
      code === 'AUTHENTICATION_FAILED' ||
      code === 'MISSING_REQUIRED_CREDENTIALS'
    ) {
      return false;
    }

    // Retryable errors (Rate limits, Timeouts, Server Glitches, Geo-Proxy 451)
    if (
      msg.includes('429') ||
      msg.includes('451') ||
      msg.includes('500') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504') ||
      msg.includes('timed out') ||
      msg.includes('network') ||
      msg.includes('econnreset') ||
      code === 'RATE_LIMIT_EXCEEDED' ||
      code === 'EXCHANGE_ERROR' ||
      code === 'REGION_NOT_SUPPORTED'
    ) {
      return true;
    }

    return true; // Default fallback to retry for unrecognized transient errors
  }

  public tryAcquireRetryToken(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  public getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + elapsedSec * this.refillRatePerSec);
      this.lastRefill = now;
    }
  }
}
