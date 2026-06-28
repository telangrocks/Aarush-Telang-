// src/utils/auth.ts

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