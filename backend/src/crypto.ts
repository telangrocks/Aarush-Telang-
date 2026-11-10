// src/utils/crypto.ts
import { LruTtlCache } from "./infrastructure/cache/LruTtlCache";

export function cleanCredential(val: string | undefined | null): string {
  if (!val) return "";
  return val
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

const DERIVED_KEY_CACHE = new LruTtlCache<string, CryptoKey>(500, 15 * 60 * 1000);

export function __resetDerivedKeyCacheForTests(): void {
  DERIVED_KEY_CACHE.clear();
}

export function __getDerivedKeyCacheStatsForTests() {
  return DERIVED_KEY_CACHE.getStats();
}

function getSaltKey(secret: string, salt: BufferSource): string {
  let saltStr: string;
  if (salt instanceof Uint8Array) {
    saltStr = btoa(Array.from(salt).map(b => String.fromCharCode(b)).join(''));
  } else if (ArrayBuffer.isView(salt)) {
    const bytes = new Uint8Array(salt.buffer, salt.byteOffset, salt.byteLength);
    saltStr = btoa(Array.from(bytes).map(b => String.fromCharCode(b)).join(''));
  } else if (salt instanceof ArrayBuffer) {
    saltStr = btoa(Array.from(new Uint8Array(salt)).map(b => String.fromCharCode(b)).join(''));
  } else {
    saltStr = String(salt);
  }
  return `${secret.length}:${secret}:${saltStr}`;
}

export async function getKey(secret: string, salt: BufferSource): Promise<CryptoKey> {
  const cacheKey = getSaltKey(secret, salt);
  const cached = DERIVED_KEY_CACHE.get(cacheKey);
  if (cached) return cached;

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  const derived = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  DERIVED_KEY_CACHE.set(cacheKey, derived);
  return derived;
}

export async function encrypt(text: string, secret: string): Promise<{ iv: string; encrypted: string; salt: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await getKey(secret, salt);
  const encoded = new TextEncoder().encode(text);

  const encryptedContent = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encoded,
  );

  const encryptedBase64 = btoa(String.fromCharCode(...new Uint8Array(encryptedContent)));
  const ivBase64 = btoa(String.fromCharCode(...iv));
  const saltBase64 = btoa(String.fromCharCode(...salt));

  return { iv: ivBase64, encrypted: encryptedBase64, salt: saltBase64 };
}

export async function decrypt(encryptedData: { iv: string; encrypted: string; salt?: string | null }, secret: string): Promise<string> {
  const iv = new Uint8Array(Array.from(atob(encryptedData.iv), c => c.charCodeAt(0)));
  const salt = encryptedData.salt
    ? new Uint8Array(Array.from(atob(encryptedData.salt), c => c.charCodeAt(0)))
    : iv;
  const key = await getKey(secret, salt);

  const encrypted = new Uint8Array(Array.from(atob(encryptedData.encrypted), c => c.charCodeAt(0)));

  const decryptedContent = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv,
    },
    key,
    encrypted,
  );

  return new TextDecoder().decode(decryptedContent);
}

export { computeAccountFingerprint } from './utils/accountFingerprint';
