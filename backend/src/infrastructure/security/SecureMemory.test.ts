import { describe, it, expect } from 'vitest';
import { SecureMemory } from './SecureMemory';

describe('Milestone 2 — SecureMemory Cryptographic Hardening Unit Tests', () => {
  it('timingSafeEqual correctly compares matching and non-matching strings', () => {
    const secret = 'super_secret_hmac_signature_999';
    const equalCopy = 'super_secret_hmac_signature_999';
    const fakeSignature = 'super_secret_hmac_signature_888';
    const shortSignature = 'short';

    expect(SecureMemory.timingSafeEqual(secret, equalCopy)).toBe(true);
    expect(SecureMemory.timingSafeEqual(secret, fakeSignature)).toBe(false);
    expect(SecureMemory.timingSafeEqual(secret, shortSignature)).toBe(false);
  });

  it('generateSecureNonce creates non-zero random byte array', () => {
    const nonce1 = SecureMemory.generateSecureNonce(16);
    const nonce2 = SecureMemory.generateSecureNonce(16);

    expect(nonce1).toHaveLength(16);
    expect(nonce2).toHaveLength(16);
    expect(SecureMemory.timingSafeEqual(Array.from(nonce1).join(','), Array.from(nonce2).join(','))).toBe(false);
  });

  it('zeroizeBuffer overwrites mutable TypedArray with zeros', () => {
    const buffer = new Uint8Array([10, 20, 30, 40, 50]);
    SecureMemory.zeroizeBuffer(buffer);

    expect(Array.from(buffer)).toEqual([0, 0, 0, 0, 0]);
  });
});
