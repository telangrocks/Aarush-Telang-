export class RetryPolicy {
  constructor(
    private readonly maxRetries: number = 3,
    private readonly baseDelayMs: number = 250,
    private readonly maxDelayMs: number = 1000,
    private readonly jitterFactor: number = 0.2
  ) {}

  public async execute<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (attempt < this.maxRetries) {
      try {
        return await operation();
      } catch (err: any) {
        attempt++;
        if (attempt >= this.maxRetries) {
          throw err;
        }
        const expDelay = Math.min(this.baseDelayMs * Math.pow(2, attempt - 1), this.maxDelayMs);
        const jitter = expDelay * this.jitterFactor * (Math.random() * 2 - 1);
        const delay = Math.max(0, Math.floor(expDelay + jitter));
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error('Retry exhausted');
  }
}
