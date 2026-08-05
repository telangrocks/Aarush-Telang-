import { describe, it, expect } from 'vitest';
import { RetryBudget } from './RetryBudget';

describe('Milestone 2 — RetryBudget Runtime Unit Tests', () => {
  it('isRetryable classifies transient vs permanent errors correctly', () => {
    const budget = new RetryBudget();

    // Retryable
    expect(budget.isRetryable(new Error('HTTP 429 Rate limit exceeded'))).toBe(true);
    expect(budget.isRetryable(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(budget.isRetryable(new Error('Operation timed out after 5000ms'))).toBe(true);
    expect(budget.isRetryable({ code: 'REGION_NOT_SUPPORTED', message: 'HTTP 451' })).toBe(true);

    // Non-retryable
    expect(budget.isRetryable(new Error('HTTP 401 Authentication failed'))).toBe(false);
    expect(budget.isRetryable({ code: 'MISSING_REQUIRED_CREDENTIALS', message: 'Missing API key' })).toBe(false);
    expect(budget.isRetryable(new Error('Insufficient funds in wallet'))).toBe(false);
  });

  it('tryAcquireRetryToken manages token consumption and refill', () => {
    const budget = new RetryBudget(2, 0); // Max 2 tokens, 0 refill rate
    expect(budget.getAvailableTokens()).toBe(2);

    expect(budget.tryAcquireRetryToken()).toBe(true);
    expect(budget.tryAcquireRetryToken()).toBe(true);
    expect(budget.tryAcquireRetryToken()).toBe(false); // Budget exhausted
  });
});
