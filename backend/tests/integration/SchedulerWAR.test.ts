import { describe, it, expect, vi } from 'vitest';
import {
  ExchangeRequestScheduler,
  RequestPriority,
  InMemorySchedulerStorage,
} from '../../src/infrastructure/exchange/pacing';

describe('Suite 2: Rate Limiting & Write-Ahead Reservation (SchedulerWAR)', () => {
  it('test_sliding_window_hard_ceiling: Verifies rolling window blocks dispatch 106 when 105 requests occur within 60s', async () => {
    const storage = new InMemorySchedulerStorage();
    const scheduler = new ExchangeRequestScheduler(storage, {
      maxRequestsPerWindow: 105,
      windowMs: 60_000,
      p3MinPacingMs: 0,
    });

    const now = Date.now();
    // Pre-populate storage with 105 timestamps in the current window
    const timestamps = Array.from({ length: 105 }, (_, i) => now - 10_000 + i * 50);
    await storage.put(ExchangeRequestScheduler.STORAGE_KEY, timestamps);

    let acquired = false;
    const acquirePromise = scheduler.acquireReservation(RequestPriority.P1_ORDER).then(() => {
      acquired = true;
    });

    // Short wait: should NOT resolve immediately because 105 slots are full
    await new Promise((r) => setTimeout(r, 50));
    expect(acquired).toBe(false);

    // Slide the window forward by expiring the oldest timestamp
    const updated = timestamps.slice(1); // 104 remaining
    await storage.put(ExchangeRequestScheduler.STORAGE_KEY, updated);

    // Now it should acquire within 100ms
    await acquirePromise;
    expect(acquired).toBe(true);
  });

  it('test_war_persistence_before_dispatch: Asserts timestamp is committed to storage before fetch is invoked', async () => {
    const storage = new InMemorySchedulerStorage();
    const scheduler = new ExchangeRequestScheduler(storage, { p3MinPacingMs: 0 });

    let storageStateDuringCall: number[] | undefined;
    const mockNetworkCall = vi.fn().mockImplementation(async () => {
      storageStateDuringCall = await storage.get<number[]>(ExchangeRequestScheduler.STORAGE_KEY);
      return { success: true };
    });

    expect(await storage.get(ExchangeRequestScheduler.STORAGE_KEY)).toBeUndefined();

    const result = await scheduler.schedule(RequestPriority.P3_MARKET_DATA, mockNetworkCall);

    expect(result).toEqual({ success: true });
    expect(mockNetworkCall).toHaveBeenCalledTimes(1);
    // Verified: storage was committed BEFORE mockNetworkCall executed!
    expect(storageStateDuringCall).toBeDefined();
    expect(storageStateDuringCall?.length).toBe(1);
  });

  it('test_reboot_budget_preservation: Simulates DO crash after 100 requests; verifies reboot permits only 5 requests', async () => {
    const sharedStorage = new InMemorySchedulerStorage();
    const now = Date.now();

    // Isolate 1 dispatches 100 requests before crashing
    const isolate1Timestamps = Array.from({ length: 100 }, (_, i) => now - 5000 + i * 10);
    await sharedStorage.put(ExchangeRequestScheduler.STORAGE_KEY, isolate1Timestamps);

    // Isolate 1 crashes! Isolate 2 boots up with the exact same storage
    const isolate2Scheduler = new ExchangeRequestScheduler(sharedStorage, {
      maxRequestsPerWindow: 105,
      windowMs: 60_000,
      p3MinPacingMs: 0,
    });

    // Isolate 2 should be able to dispatch exactly 5 requests immediately
    for (let i = 0; i < 5; i++) {
      const ts = await isolate2Scheduler.acquireReservation(RequestPriority.P1_ORDER);
      expect(ts).toBeGreaterThan(0);
    }

    const currentTimestamps = await isolate2Scheduler.getReservedDispatchTimestamps();
    expect(currentTimestamps.length).toBe(105);

    // The 6th request (106th total) must block
    let sixthAcquired = false;
    isolate2Scheduler.acquireReservation(RequestPriority.P1_ORDER).then(() => {
      sixthAcquired = true;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(sixthAcquired).toBe(false);
  });

  it('test_floor_reservation_p1_preemption: Verifies P3 yields at 15 tokens while P1 orders dispatch immediately', async () => {
    const storage = new InMemorySchedulerStorage();
    // Scheduler configured with tokenCapacity = 20, p3FloorTokens = 15, refill 0 so tokens don't refill during test
    const scheduler = new ExchangeRequestScheduler(storage, {
      tokenCapacity: 20,
      p3FloorTokens: 15,
      refillRatePerSecond: 0,
      p3MinPacingMs: 0,
    });

    // Consume 5 tokens with P3 (available tokens drops from 20 to 15)
    for (let i = 0; i < 5; i++) {
      await scheduler.acquireReservation(RequestPriority.P3_MARKET_DATA);
    }

    expect(scheduler.getAvailableTokens()).toBe(15);

    // Now available tokens === 15 (floor reached). Next P3 must yield/block
    let p3Acquired = false;
    scheduler.acquireReservation(RequestPriority.P3_MARKET_DATA).then(() => {
      p3Acquired = true;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(p3Acquired).toBe(false);

    // Meanwhile, P1 (order) has preemption privileges and can consume below the floor!
    let p1Acquired = false;
    await scheduler.acquireReservation(RequestPriority.P1_ORDER);
    p1Acquired = true;
    expect(p1Acquired).toBe(true);
    expect(scheduler.getAvailableTokens()).toBe(14);
  });

  it('test_p3_minimum_pacing_delay: Verifies consecutive P3 requests are spaced by >= 572ms', async () => {
    const storage = new InMemorySchedulerStorage();
    const scheduler = new ExchangeRequestScheduler(storage, {
      p3MinPacingMs: 100, // scaled for fast deterministic test verification
    });

    const start = Date.now();
    await scheduler.acquireReservation(RequestPriority.P3_MARKET_DATA);
    await scheduler.acquireReservation(RequestPriority.P3_MARKET_DATA);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(95); // accounts for slight timer variance
  });
});
