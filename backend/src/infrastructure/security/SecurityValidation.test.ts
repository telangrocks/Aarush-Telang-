import { describe, it, expect } from 'vitest';
import { SecretManager } from './SecretManager';
import { SecureMemory } from './SecureMemory';
import { ExchangePermissionSet } from './SecurityPolicy';
import { PermissionValidator } from './PermissionValidator';
import { AuditLogger } from './AuditLogger';
import { SecurityAwareCache } from './SecurityAwareCache';
import { SecurityState } from './SecurityState';

describe('Milestone 6 — Phase 3 Comprehensive Security Validation Test Suite', () => {
  it('Security Test 1: Full Credential Lifecycle & Version Rotation', () => {
    const manager = new SecretManager();
    
    // Register
    const regRes = manager.registerCredential('user_alpha', 'binance', 'key_111', 'sec_enc_1', 'iv_1', 'mainnet');
    expect(regRes.isSuccess).toBe(true);
    if (regRes.isSuccess) {
      expect(regRes.value.version).toBe(1);
    }

    // Rotate
    const rotRes = manager.rotateCredential('user_alpha', 'binance', 'key_222', 'sec_enc_2', 'iv_2', 'mainnet');
    expect(rotRes.isSuccess).toBe(true);
    if (rotRes.isSuccess) {
      expect(rotRes.value.version).toBe(2);
    }

    // Revoke
    manager.revokeCredential('user_alpha', 'binance', 'mainnet');
    const activeRes = manager.getActiveCredential('user_alpha', 'binance', 'mainnet');
    expect(activeRes.isFailure).toBe(true);
  });

  it('Security Test 2: Permission Escalation Prevention', () => {
    const readOnlySet: ExchangePermissionSet = {
      environment: 'mainnet',
      capabilities: new Set(['CAN_READ', 'CAN_STREAM']),
    };

    const tradeAttempt = PermissionValidator.validatePermission(readOnlySet, 'CAN_TRADE', 'mainnet');
    expect(tradeAttempt.isFailure).toBe(true);
    if (tradeAttempt.isFailure) {
      expect(tradeAttempt.error.message).toContain("Missing required capability 'CAN_TRADE'");
    }
  });

  it('Security Test 3: Environment Isolation & Leakage Prevention', () => {
    const testnetSet: ExchangePermissionSet = {
      environment: 'testnet',
      capabilities: new Set(['CAN_READ', 'CAN_TRADE']),
    };

    const mainnetAttempt = PermissionValidator.validatePermission(testnetSet, 'CAN_TRADE', 'mainnet');
    expect(mainnetAttempt.isFailure).toBe(true);
    if (mainnetAttempt.isFailure) {
      expect(mainnetAttempt.error.message).toContain('Environment mismatch');
    }
  });

  it('Security Test 4: Tenant & Credential-Versioned Cache Key Isolation', async () => {
    const cache = new SecurityAwareCache<any>();
    await cache.set('tenant_1', 'mainnet', 'kucoin', 1, '/api/v3/orders', { openOrders: 2 });

    // Version 1 accessible
    expect(await cache.get('tenant_1', 'mainnet', 'kucoin', 1, '/api/v3/orders')).toEqual({ openOrders: 2 });

    // Version 2 (post-rotation) returns null naturally
    expect(await cache.get('tenant_1', 'mainnet', 'kucoin', 2, '/api/v3/orders')).toBeNull();

    // Tenant 2 returns null (tenant isolation)
    expect(await cache.get('tenant_2', 'mainnet', 'kucoin', 1, '/api/v3/orders')).toBeNull();
  });

  it('Security Test 5: Constant-Time HMAC Signature Verification', () => {
    const validHmac = '4f8b9e1c2a3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f';
    const fakeHmac = '4f8b9e1c2a3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e90';

    expect(SecureMemory.timingSafeEqual(validHmac, validHmac)).toBe(true);
    expect(SecureMemory.timingSafeEqual(validHmac, fakeHmac)).toBe(false);
  });

  it('Security Test 6: Immutable Append-Only Audit Logging Integrity', async () => {
    const logger = new AuditLogger();
    await logger.logSecurityEvent('CREDENTIAL_REGISTERED', 'user_beta', 'mainnet', 'bybit');
    await logger.logSecurityEvent('PERMISSION_DENIED', 'user_beta', 'mainnet', 'bybit', { reason: 'No trade permission' });

    const logs = logger.getImmutableAuditLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0].securityAction).toBe('CREDENTIAL_REGISTERED');
    expect(logs[1].securityAction).toBe('PERMISSION_DENIED');
  });

  it('Security Test 7: Immutable SecurityState Snapshot Tracking', () => {
    let state = SecurityState.createDefault();
    expect(state.isSecurityHealthy).toBe(true);

    state = state.withCredentialStatus('user_1:binance', 'ACTIVE');
    expect(state.credentialStatus.get('user_1:binance')).toBe('ACTIVE');

    state = state.withViolation();
    expect(state.securityViolationsCount).toBe(1);
  });
});
