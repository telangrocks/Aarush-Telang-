// src/utils/auth.ts
import { sign } from 'hono/jwt';

const ITERATIONS = 100000;
const HASH_ALGORITHM = 'SHA-256';

/**
 * Hashes a password using PBKDF2 with SHA-256.
 * Generates a random salt for each password and stores it with the hash.
 * @param password The plain-text password.
 * @returns A string containing the salt and hash, separated by a colon.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const key = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: ITERATIONS, hash: HASH_ALGORITHM },
    keyMaterial,
    256
  );

  const hash = btoa(String.fromCharCode(...new Uint8Array(key)));
  const saltString = btoa(String.fromCharCode(...salt));

  return `${saltString}:${hash}`;
}

/**
 * Verifies a password against a stored hash.
 * @param password The plain-text password to verify.
 * @param storedHash The stored string containing the salt and hash.
 * @returns True if the password is valid, false otherwise.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [saltString, hash] = storedHash.split(':');
  if (!saltString || !hash) {
    return false; // Invalid hash format
  }

  const salt = new Uint8Array(Array.from(atob(saltString), c => c.charCodeAt(0)));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const key = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: ITERATIONS, hash: HASH_ALGORITHM }, keyMaterial, 256);

  const newHash = btoa(String.fromCharCode(...new Uint8Array(key)));
  return newHash === hash;
}

/**
 * Generates a JSON Web Token (JWT) for a user.
 */
export async function generateJwt(userId: string, email: string, secret: string): Promise<string> {
  return sign(
    { sub: userId, email, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 }, // 7-day expiration
    secret
  );
}