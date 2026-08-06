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
    const code = (error as any)?.code || (error as any)?.errorCode;

    const nonRetryableCodes = new Set([
      'INVALID_API_KEY',
      'INVALID_API_SECRET',
      'INVALID_PASSPHRASE',
      'IP_NOT_WHITELISTED',
      'INSUFFICIENT_PERMISSIONS',
      'PERMISSION_DENIED',
      'AUTHENTICATION_FAILED',
      'MISSING_REQUIRED_CREDENTIALS',
      'INVALID_SIGNATURE',
      'SPOT_TRADING_NOT_ENABLED',
      'ACCOUNT_SUSPENDED',
      'ACCOUNT_RESTRICTED',
      'UNSUPPORTED_OPERATION',
    ]);

    if (code && nonRetryableCodes.has(code)) {
      return false;
    }

    const retryableCodes = new Set([
      'API_RATE_LIMIT_REACHED',
      'RATE_LIMIT_EXCEEDED',
      'NETWORK_TIMEOUT',
      'SERVICE_TEMPORARILY_UNAVAILABLE',
      'EXCHANGE_UNDER_MAINTENANCE',
      'EXCHANGE_NOT_REACHABLE',
      'BINANCE_WAF_BLOCKED',
      'BINANCE_NETWORK_BLOCKED',
      'UPSTREAM_PROVIDER_BLOCKED',
      'REGION_NOT_SUPPORTED',
      'EXCHANGE_ERROR',
    ]);

    if (code && retryableCodes.has(code)) {
      return true;
    }

    // Fallback message inspection if code property is absent or generic
    const msg = String((error as any)?.message || error).toLowerCase();
    if (
      msg.includes('401') ||
      msg.includes('403') ||
      msg.includes('authentication') ||
      msg.includes('credentials') ||
      msg.includes('insufficient funds') ||
      msg.includes('insufficient_funds') ||
      msg.includes('invalid_symbol') ||
      msg.includes('unsupported_operation')
    ) {
      return false;
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
