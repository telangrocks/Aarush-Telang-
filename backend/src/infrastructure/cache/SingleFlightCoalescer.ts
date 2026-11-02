/**
 * SingleFlightCoalescer: Isolate-level duplicate request suppression (Single-Flight pattern).
 *
 * Ensures that for a given key, at most one execution of an asynchronous operation is in-flight
 * at any moment within the current V8 isolate. Concurrent callers requesting the same key join
 * and await the existing in-flight Promise rather than launching redundant upstream calls.
 *
 * Guarantees:
 * 1. Concurrency Deduplication: Concurrent callers with identical keys receive the exact same Promise resolution.
 * 2. Safe Cleanup: Upon settlement (resolution or rejection — including synchronous throws), the in-flight entry
 *    is guaranteed to be removed without leaking stale or rejected promises.
 * 3. Error Recovery: Failed executions are immediately evicted so subsequent requests retry cleanly.
 * 4. Identity Guard: A settled promise only deletes its own map slot, preventing cross-generation eviction races.
 */
export class SingleFlightCoalescer<T> {
  private readonly inFlight = new Map<string, { promise: Promise<T>; subscribers: number }>();
  private totalFlights = 0;
  private coalescedFollowers = 0;

  /**
   * Executes `fn` once per active flight for `key`, coalescing concurrent callers onto the same Promise.
   */
  public do(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      existing.subscribers += 1;
      this.coalescedFollowers += 1;
      return existing.promise;
    }

    this.totalFlights += 1;
    let settled = false;
    let flightPromise!: Promise<T>;

    const run = async (): Promise<T> => {
      try {
        return await fn();
      } finally {
        settled = true;
        const current = this.inFlight.get(key);
        if (current && current.promise === flightPromise) {
          this.inFlight.delete(key);
        }
      }
    };

    flightPromise = run();

    if (!settled) {
      this.inFlight.set(key, {
        promise: flightPromise,
        subscribers: 1,
      });
    }

    return flightPromise;
  }

  /**
   * Returns true if an operation for `key` is currently in-flight.
   */
  public isInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  /**
   * Returns active subscriber count for `key`, or 0 if not in-flight.
   */
  public getSubscriberCount(key: string): number {
    return this.inFlight.get(key)?.subscribers ?? 0;
  }

  /**
   * Returns total number of distinct keys currently in-flight.
   */
  public getActiveCount(): number {
    return this.inFlight.size;
  }

  /**
   * Returns cumulative coalescing statistics.
   */
  public getStats() {
    return {
      totalFlights: this.totalFlights,
      coalescedFollowers: this.coalescedFollowers,
      activeCount: this.inFlight.size,
    };
  }

  /**
   * Clears in-flight tracking map (intended for deterministic test teardown).
   */
  public clear(): void {
    this.inFlight.clear();
  }
}
