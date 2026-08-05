export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number = 1200,
    private readonly refillRatePerSec: number = 20
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  public tryConsume(weight: number = 1): boolean {
    this.refill();
    if (this.tokens >= weight) {
      this.tokens -= weight;
      return true;
    }
    return false;
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
