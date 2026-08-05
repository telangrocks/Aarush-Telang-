import { describe, it, expect } from 'vitest';
import { PermissionValidator } from './PermissionValidator';
import { ExchangePermissionSet } from './SecurityPolicy';

describe('Milestone 3 — PermissionValidator & Capability Policy Unit Tests', () => {
  it('PermissionValidator allows authorized trading capability on matching environment', () => {
    const permissions: ExchangePermissionSet = {
      environment: 'mainnet',
      capabilities: new Set(['CAN_READ', 'CAN_TRADE', 'CAN_STREAM']),
    };

    const readRes = PermissionValidator.validatePermission(permissions, 'CAN_READ', 'mainnet');
    expect(readRes.isSuccess).toBe(true);

    const tradeRes = PermissionValidator.validatePermission(permissions, 'CAN_TRADE', 'mainnet');
    expect(tradeRes.isSuccess).toBe(true);
  });

  it('PermissionValidator rejects read-only credentials attempting CAN_TRADE capability', () => {
    const readOnlyPermissions: ExchangePermissionSet = {
      environment: 'mainnet',
      capabilities: new Set(['CAN_READ', 'CAN_STREAM']),
    };

    const tradeRes = PermissionValidator.validatePermission(readOnlyPermissions, 'CAN_TRADE', 'mainnet');
    expect(tradeRes.isFailure).toBe(true);
    if (tradeRes.isFailure) {
      expect(tradeRes.error.message).toContain("Missing required capability 'CAN_TRADE'");
    }
  });

  it('PermissionValidator enforces strict environment isolation (testnet vs mainnet)', () => {
    const testnetPermissions: ExchangePermissionSet = {
      environment: 'testnet',
      capabilities: new Set(['CAN_READ', 'CAN_TRADE']),
    };

    const mainnetAttempt = PermissionValidator.validatePermission(testnetPermissions, 'CAN_TRADE', 'mainnet');
    expect(mainnetAttempt.isFailure).toBe(true);
    if (mainnetAttempt.isFailure) {
      expect(mainnetAttempt.error.message).toContain('Environment mismatch');
    }
  });
});
