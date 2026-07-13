// src/utils/auth.ts

import { sign } from 'hono/jwt';
/**
 * Hashes a password using PBKDF2 with SHA-256.
 * @param password The plain-text password.
 * @returns A string containing the salt and hash, separated by a colon.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']);
  const derivedKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const keyBytes = await crypto.subtle.exportKey('raw', derivedKey);
  const saltString = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashString = Array.from(new Uint8Array(keyBytes)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${saltString}:${hashString}`;
}

/**
 * Verifies a password against a stored hash.
 * @param password The plain-text password to verify.
 * @param storedHash The stored hash (including salt).
 * @returns A boolean indicating if the password is correct.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const [saltString, hashString] = storedHash.split(':');
    if (!saltString || !hashString) return false;

    const salt = new Uint8Array(saltString.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    const encoder = new TextEncoder();

    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']);
    const derivedKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );

    const keyBytes = await crypto.subtle.exportKey('raw', derivedKey);
    const computed = new Uint8Array(keyBytes);
    const expected = hexToBytes(hashString);

    if (computed.length !== expected.length) return false;
    // Constant-time comparison to avoid timing side-channels.
    return crypto.subtle.timingSafeEqual(computed, expected);
  } catch (error) {
    console.error("Password verification error:", error);
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const matches = hex.match(/.{1,2}/g);
  if (!matches) return new Uint8Array(0);
  return new Uint8Array(matches.map(byte => parseInt(byte, 16)));
}
}

/**
 * Generates a JWT for a given user.
 */
export async function generateJwt(userId: string, email: string, secret: string): Promise<string> {
  const payload = { sub: userId, email, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 }; // 7-day expiration
  return sign(payload, secret);
}