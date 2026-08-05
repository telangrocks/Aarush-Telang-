import { describe, it, expect } from 'vitest';
import { SecretManager } from './SecretManager';

describe('Milestone 1 — SecretManager Credential Lifecycle Unit Tests', () => {
  it('SecretManager registers, version-increments, and retrieves active credentials', () => {
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
  });

  it('SecretManager rotates credentials and increments version number', () => {
    const manager = new SecretManager();
    manager.registerCredential('usr_100', 'binance', 'key_v1', 'sec_enc_1', 'iv_1', 'mainnet');

    const rotRes = manager.rotateCredential('usr_100', 'binance', 'key_v2', 'sec_enc_2', 'iv_2', 'mainnet');
    expect(rotRes.isSuccess).toBe(true);
    if (rotRes.isSuccess) {
      expect(rotRes.value.version).toBe(2);
      expect(rotRes.value.apiKey).toBe('key_v2');
    }
  });

  it('SecretManager revokes credentials and denies active access', () => {
    const manager = new SecretManager();
    manager.registerCredential('usr_100', 'kucoin', 'key_k1', 'sec_k1', 'iv_k1', 'mainnet');

    manager.revokeCredential('usr_100', 'kucoin', 'mainnet');
    const activeRes = manager.getActiveCredential('usr_100', 'kucoin', 'mainnet');

    expect(activeRes.isFailure).toBe(true);
    if (activeRes.isFailure) {
      expect(activeRes.error.message).toContain('REVOKED');
    }
  });

  it('SecretManager expires credentials past TTL', async () => {
    const manager = new SecretManager();
    manager.registerCredential('usr_100', 'bybit', 'key_b1', 'sec_b1', 'iv_b1', 'mainnet', undefined, undefined, 20); // 20ms TTL

    await new Promise(r => setTimeout(r, 40));
    const activeRes = manager.getActiveCredential('usr_100', 'bybit', 'mainnet');

    expect(activeRes.isFailure).toBe(true);
    if (activeRes.isFailure) {
      expect(activeRes.error.message).toContain('EXPIRED');
    }
  });
});
