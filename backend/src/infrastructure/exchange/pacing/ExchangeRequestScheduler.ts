/**
 * Per-TradingBot Durable Object Exchange Request Scheduler
 * 
 * Enforces:
 * 1. Durable sliding-window log (<= 105 requests / rolling 60,000ms window)
 *    persisted in state.storage ('rateLimit:reservedDispatchTimestamps').
 *    Reservation Invariant: A timestamp persisted here represents an admitted/reserved
 *    outbound request slot under the durable 105/60s ceiling. It is committed prior to
 *    network dispatch (WAR) to prevent rate-limit leaks across isolate restarts, and does
 *    not claim proof of physical arrival at Bybit.
 * 2. Write-Ahead Reservation (WAR): Persists reservation timestamp to durable storage
 *    BEFORE transmitting outbound HTTP requests to the exchange.
 * 3. Secondary token bucket: capacity 105, refill 1.75 tokens/s (105 / 60s).
 * 4. P3 market-data wall-clock pacing: >= 572ms spacing between consecutive P3 calls.
 * 5. Hard floor reservation: Priority 3 market-data yields when available tokens <= 15.
 *    Priority 1 (orders) and Priority 2 (reconciliation) can consume down to 0 tokens without pacing delays.
 */

export enum RequestPriority {
  P1_ORDER = 1,
  P2_RECONCILIATION = 2,
  P3_MARKET_DATA = 3,
}

export interface SchedulerConfig {
  readonly maxRequestsPerWindow: number; // 105
  readonly windowMs: number;             // 60,000 ms
  readonly tokenCapacity: number;        // 105
  readonly refillRatePerSecond: number;  // 1.75 tokens/sec
  readonly p3MinPacingMs: number;        // 572 ms
  readonly p3FloorTokens: number;        // 15 tokens
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxRequestsPerWindow: 105,
  windowMs: 60_000,
  tokenCapacity: 105,
  refillRatePerSecond: 1.75,
  p3MinPacingMs: 572,
  p3FloorTokens: 15,
};

export interface ISchedulerStorage {
  get<T = any>(key: string): Promise<T | undefined>;
  put(key: string, value: any): Promise<void>;
  put(entries: Record<string, any>): Promise<void>;
}

export class InMemorySchedulerStorage implements ISchedulerStorage {
  private map = new Map<string, any>();

  async get<T = any>(key: string): Promise<T | undefined> {
    const val = this.map.get(key);
    if (val === undefined) return undefined;
    // Return deep/shallow clone to mimic storage isolation
    return JSON.parse(JSON.stringify(val));
  }

  async put(keyOrEntries: string | Record<string, any>, value?: any): Promise<void> {
    if (typeof keyOrEntries === 'string') {
      this.map.set(keyOrEntries, JSON.parse(JSON.stringify(value)));
    } else {
      for (const [k, v] of Object.entries(keyOrEntries)) {
        this.map.set(k, v !== undefined ? JSON.parse(JSON.stringify(v)) : undefined);
      }
    }
  }
}

export class ExchangeRequestScheduler {
  public static readonly STORAGE_KEY = 'rateLimit:reservedDispatchTimestamps';

  private readonly config: SchedulerConfig;
  private readonly storage: ISchedulerStorage;

  // Secondary token bucket state (in-memory, continuous refill)
  private tokens: number;
  private lastRefillTimestamp: number;

  // P3 pacing tracker
  private lastP3DispatchTimestamp: number = 0;

  // Concurrency mutex lock to prevent internal race conditions within the DO isolate
  private mutex: Promise<void> = Promise.resolve();

  constructor(
    storage?: ISchedulerStorage,
    config: Partial<SchedulerConfig> = {}
  ) {
    this.storage = storage ?? new InMemorySchedulerStorage();
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this.tokens = this.config.tokenCapacity;
    this.lastRefillTimestamp = Date.now();
  }

  /**
   * Continuous refill of token bucket based on elapsed time.
   */
  private refillTokens(now: number): void {
    const elapsedSeconds = Math.max(0, (now - this.lastRefillTimestamp) / 1000);
    const addedTokens = elapsedSeconds * this.config.refillRatePerSecond;
    this.tokens = Math.min(this.config.tokenCapacity, this.tokens + addedTokens);
    this.lastRefillTimestamp = now;
  }

  /**
   * Acquire a Write-Ahead Reservation (WAR) for an outbound exchange call.
   * Persists timestamp to storage BEFORE returning, guaranteeing no budget leaks on isolate crash.
   */
  public async acquireReservation(priority: RequestPriority): Promise<number> {
    while (true) {
      const waitMs = await this.tryReserve(priority);
      if (waitMs <= 0) {
        return Date.now();
      }
      await this.sleep(waitMs);
    }
  }

  private acquireMutex(): Promise<() => void> {
    let release: () => void;
    const nextMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentMutex = this.mutex;
    this.mutex = currentMutex.then(() => nextMutex);
    return currentMutex.then(() => release!);
  }

  private async tryReserve(priority: RequestPriority): Promise<number> {
    const release = await this.acquireMutex();
    try {
      const now = Date.now();
      this.refillTokens(now);

      // 1. Authoritative Guard: Read durable sliding window log
      const rawTimestamps = (await this.storage.get<number[]>(ExchangeRequestScheduler.STORAGE_KEY)) || [];
      const windowStart = now - this.config.windowMs;
      const validTimestamps = rawTimestamps.filter((ts) => ts > windowStart);

      // Check hard ceiling: <= 105 requests in rolling 60,000ms
      if (validTimestamps.length >= this.config.maxRequestsPerWindow) {
        const oldest = validTimestamps[0];
        const calculatedWait = (oldest + this.config.windowMs) - now + 5;
        return Math.min(Math.max(1, Number.isFinite(calculatedWait) ? calculatedWait : 50), 100);
      }

      // Check secondary token bucket & floor
      if (priority === RequestPriority.P3_MARKET_DATA) {
        if (this.tokens <= this.config.p3FloorTokens) {
          // Token bucket is below or at floor (15 tokens reserved for P1/P2)
          const needed = this.config.p3FloorTokens + 1 - this.tokens;
          const refillRate = this.config.refillRatePerSecond > 0 ? this.config.refillRatePerSecond : 1.75;
          const calculatedWait = Math.ceil((needed / refillRate) * 1000);
          return Math.min(Math.max(10, Number.isFinite(calculatedWait) ? calculatedWait : 50), 100);
        }

        // Check P3 minimum pacing (>= 572ms)
        const timeSinceLastP3 = now - this.lastP3DispatchTimestamp;
        if (timeSinceLastP3 < this.config.p3MinPacingMs) {
          return Math.min(this.config.p3MinPacingMs - timeSinceLastP3, 100);
        }
      }

      // 2. Write-Ahead Reservation (WAR): Durably commit BEFORE the call
      const reservationTs = Date.now();
      validTimestamps.push(reservationTs);

      // Decrement token bucket
      this.tokens = Math.max(0, this.tokens - 1);
      if (priority === RequestPriority.P3_MARKET_DATA) {
        this.lastP3DispatchTimestamp = reservationTs;
      }

      // Authoritative durable storage write
      await this.storage.put(ExchangeRequestScheduler.STORAGE_KEY, validTimestamps);

      return 0; // Success
    } finally {
      release();
    }
  }

  /**
   * High-level scheduling wrapper. Durably reserves a slot via WAR,
   * then executes the outbound network call.
   */
  public async schedule<T>(
    priority: RequestPriority,
    execute: () => Promise<T>
  ): Promise<T> {
    await this.acquireReservation(priority);
    return await execute();
  }

  /**
   * Helper to inspect current available tokens in memory.
   */
  public getAvailableTokens(): number {
    this.refillTokens(Date.now());
    return this.tokens;
  }

  /**
   * Helper to inspect durable reserved dispatch timestamps in storage.
   * Invariant: Represents admitted outbound request slots under the 105/60s safety ceiling.
   */
  public async getReservedDispatchTimestamps(): Promise<number[]> {
    const raw = (await this.storage.get<number[]>(ExchangeRequestScheduler.STORAGE_KEY)) || [];
    const now = Date.now();
    return raw.filter((ts) => ts > now - this.config.windowMs);
  }

  /**
   * Backward-compatible alias for getReservedDispatchTimestamps().
   */
  public async getDispatchedTimestamps(): Promise<number[]> {
    return this.getReservedDispatchTimestamps();
  }

  /**
   * Reset scheduler state (primarily for test environments).
   */
  public async reset(): Promise<void> {
    this.tokens = this.config.tokenCapacity;
    this.lastRefillTimestamp = Date.now();
    this.lastP3DispatchTimestamp = 0;
    await this.storage.put(ExchangeRequestScheduler.STORAGE_KEY, []);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
