import { describe, it, expect } from 'vitest';
import { TimeoutPolicy, DEFAULT_TIMEOUT_CONFIG } from './TimeoutPolicy';

describe('Milestone 1 — TimeoutPolicy Runtime Unit Tests', () => {
  it('TimeoutPolicy exposes default timeout configuration', () => {
    const policy = new TimeoutPolicy();
    expect(policy.connectTimeout).toBe(DEFAULT_TIMEOUT_CONFIG.connectTimeoutMs);
    expect(policy.requestTimeout).toBe(DEFAULT_TIMEOUT_CONFIG.requestTimeoutMs);
    expect(policy.websocketHeartbeatTimeout).toBe(DEFAULT_TIMEOUT_CONFIG.websocketHeartbeatTimeoutMs);
    expect(policy.reconciliationTimeout).toBe(DEFAULT_TIMEOUT_CONFIG.reconciliationTimeoutMs);
  });

  it('executeWithTimeout succeeds when operation resolves before timeout', async () => {
    const policy = new TimeoutPolicy();
    const result = await policy.executeWithTimeout(async (_signal) => {
      return 'fast_response';
    }, 500, 'test_fast');

    expect(result.isSuccess).toBe(true);
    if (result.isSuccess) {
      expect(result.value).toBe('fast_response');
    }
  });

  it('executeWithTimeout aborts and returns failure Result when operation exceeds timeout', async () => {
    const policy = new TimeoutPolicy();
    const result = await policy.executeWithTimeout(async (_signal) => {
      await new Promise(r => setTimeout(r, 100)); // 100ms task
      return 'too_slow';
    }, 20, 'test_slow'); // 20ms limit

    expect(result.isFailure).toBe(true);
    if (result.isFailure) {
      expect(result.error.message).toContain("timed out after 20ms");
    }
  });

  it('executeWithTimeout captures inner errors gracefully', async () => {
    const policy = new TimeoutPolicy();
    const result = await policy.executeWithTimeout(async (_signal) => {
      throw new Error('Inner network error');
    }, 500, 'test_error');

    expect(result.isFailure).toBe(true);
    if (result.isFailure) {
      expect(result.error.message).toBe('Inner network error');
    }
  });
});
