import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from './CircuitBreaker';
import { RateLimiter } from './RateLimiter';
import { RetryPolicy } from './RetryPolicy';
import { ExchangeOrchestrator } from './ExchangeOrchestrator';
import { BinanceAdapter } from '../exchange/adapters/BinanceAdapter';
import BigNumber from 'bignumber.js';

describe('ExchangeOrchestrator & Infrastructure Pipeline Unit Tests', () => {
  it('CircuitBreaker transitions state on failures and cooldown', () => {
    const cb = new CircuitBreaker(2, 50); // 2 failures -> OPEN, 50ms cooldown
    expect(cb.canExecute()).toBe(true);

    cb.recordFailure();
    expect(cb.canExecute()).toBe(true);

    cb.recordFailure();
    expect(cb.canExecute()).toBe(false); // OPEN state
  });

  it('RateLimiter consumes tokens and prevents burst exhaustion', () => {
    const limiter = new RateLimiter(2, 0); // Max 2 tokens, 0 refill
    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(false); // Token bucket empty
  });

  it('RetryPolicy executes exponential retries', async () => {
    const policy = new RetryPolicy(2, 10, 20);
    let attempts = 0;
    const res = await policy.execute(async () => {
      attempts++;
      if (attempts === 1) throw new Error('Transient failure');
      return 'success';
    });
    expect(res).toBe('success');
    expect(attempts).toBe(2);
  });

  it('ExchangeOrchestrator executes pipeline operations and returns Result domain objects', async () => {
    const orchestrator = new ExchangeOrchestrator();
    const adapter = new BinanceAdapter();
    adapter.fetchTicker = async (sym: string) => ({
      symbol: sym,
      timestamp: Date.now(),
      last: new BigNumber(50000),
      bid: new BigNumber(50000),
      ask: new BigNumber(50000),
      high: new BigNumber(51000),
      low: new BigNumber(49000),
      volume: new BigNumber(100),
      quoteVolume: new BigNumber(5000000),
    });

    const result = await orchestrator.execute(adapter, 'fetchTicker', async (a) => {
      return a.fetchTicker('BTC/USDT');
    });

    expect(result.isSuccess).toBe(true);
    if (result.isSuccess) {
      expect(result.value.symbol).toBe('BTC/USDT');
    }
  });
});
