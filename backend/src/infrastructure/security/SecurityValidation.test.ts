import { describe, it, expect } from 'vitest';
import { SecretManager } from './SecretManager';
import { SecureMemory } from './SecureMemory';
import { ExchangePermissionSet } from './SecurityPolicy';
import { PermissionValidator } from './PermissionValidator';
import { AuditLogger } from './AuditLogger';
import { SecurityAwareCache } from './SecurityAwareCache';
import { SecurityState } from './SecurityState';
import { EventBus } from '../../domain/events/EventBus';

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

  describe('Consolidated Component Unit Invariants (SecretManager, SecureMemory, AuditLogger, SecurityAwareCache)', () => {
    it('SecretManager verifies ACTIVE state, apiKey retrieval, REVOKED reason, and expires credentials past TTL', async () => {
      const manager = new SecretManager();
      const regRes = manager.registerCredential('usr_100', 'binance', 'key_v1', 'sec_enc_1', 'iv_1', 'mainnet');
      expect(regRes.isSuccess).toBe(true);
      if (regRes.isSuccess) {
        expect(regRes.value.version).toBe(1);
        expect(regRes.value.state).toBe('ACTIVE');
      }

      const activeRes = manager.getActiveCredential('usr_100', 'binance', 'mainnet');
      expect(activeRes.isSuccess).toBe(true);
      if (activeRes.isSuccess) {
        expect(activeRes.value.apiKey).toBe('key_v1');
      }

      const rotRes = manager.rotateCredential('usr_100', 'binance', 'key_v2', 'sec_enc_2', 'iv_2', 'mainnet');
      expect(rotRes.isSuccess).toBe(true);
      if (rotRes.isSuccess) {
        expect(rotRes.value.version).toBe(2);
        expect(rotRes.value.apiKey).toBe('key_v2');
      }

      manager.revokeCredential('usr_100', 'binance', 'mainnet');
      const revokedRes = manager.getActiveCredential('usr_100', 'binance', 'mainnet');
      expect(revokedRes.isFailure).toBe(true);
      if (revokedRes.isFailure) {
        expect(revokedRes.error.message).toContain('REVOKED');
      }

      manager.registerCredential('usr_100', 'bybit', 'key_b1', 'sec_b1', 'iv_b1', 'mainnet', undefined, undefined, 20);
      await new Promise((r) => setTimeout(r, 40));
      const expiredRes = manager.getActiveCredential('usr_100', 'bybit', 'mainnet');
      expect(expiredRes.isFailure).toBe(true);
      if (expiredRes.isFailure) {
        expect(expiredRes.error.message).toContain('EXPIRED');
      }
    });

    it('SecureMemory handles mismatched-length timingSafeEqual, generateSecureNonce, and zeroizeBuffer', () => {
      expect(SecureMemory.timingSafeEqual('super_secret_hmac_signature_999', 'short')).toBe(false);

      const nonce1 = SecureMemory.generateSecureNonce(16);
      const nonce2 = SecureMemory.generateSecureNonce(16);
      expect(nonce1).toHaveLength(16);
      expect(nonce2).toHaveLength(16);
      expect(SecureMemory.timingSafeEqual(Array.from(nonce1).join(','), Array.from(nonce2).join(','))).toBe(false);

      const buffer = new Uint8Array([10, 20, 30, 40, 50]);
      SecureMemory.zeroizeBuffer(buffer);
      expect(Array.from(buffer)).toEqual([0, 0, 0, 0, 0]);
    });

    it('AuditLogger publishes immutable SECURITY_AUDIT_EVENT to EventBus and tracks ENVIRONMENT_VIOLATION', async () => {
      const bus = new EventBus();
      const auditLogger = new AuditLogger(bus);

      const publishedEvents: any[] = [];
      bus.subscribe('SECURITY_AUDIT_EVENT', (evt) => {
        publishedEvents.push(evt);
      });

      const evt = await auditLogger.logSecurityEvent('CREDENTIAL_ROTATED', 'usr_sec_10', 'mainnet', 'binance', {
        version: 2,
      });
      expect(evt.securityAction).toBe('CREDENTIAL_ROTATED');
      expect(evt.userId).toBe('usr_sec_10');

      await auditLogger.logSecurityEvent('ENVIRONMENT_VIOLATION', 'usr_hacker', 'mainnet', 'kucoin', {
        attemptedEnv: 'sandbox',
      });

      const logs = auditLogger.getImmutableAuditLogs();
      expect(logs).toHaveLength(2);
      expect(logs[0].eventId).toBe(evt.eventId);
      expect(logs[1].securityAction).toBe('ENVIRONMENT_VIOLATION');
      expect(publishedEvents).toHaveLength(2);
      expect(publishedEvents[0].eventId).toBe(evt.eventId);
      expect(publishedEvents[1].securityAction).toBe('ENVIRONMENT_VIOLATION');
    });

    it('SecurityAwareCache prevents cross-environment cache poisoning between mainnet and testnet', async () => {
      const cache = new SecurityAwareCache<any>();
      await cache.set('usr_10', 'mainnet', 'binance', 1, '/api/v3/account', { balance: 5000 });

      expect(await cache.get('usr_10', 'mainnet', 'binance', 1, '/api/v3/account')).toEqual({ balance: 5000 });
      expect(await cache.get('usr_10', 'testnet', 'binance', 1, '/api/v3/account')).toBeNull();
    });
  });
});
