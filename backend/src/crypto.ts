// src/utils/crypto.ts

async function getKey(secret: string, salt: BufferSource): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function encrypt(text: string, secret: string): Promise<{ iv: string; encrypted: string }> {
  // A fresh, random 12-byte IV is generated per encryption and is reused as the
  // PBKDF2 salt. This guarantees a unique derived key for every ciphertext
  // (unlike a fixed salt) while requiring no extra stored column.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getKey(secret, iv);
  const encoded = new TextEncoder().encode(text);

  const encryptedContent = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encoded,
  );

  const encryptedBase64 = btoa(String.fromCharCode(...new Uint8Array(encryptedContent)));
  const ivBase64 = btoa(String.fromCharCode(...iv));

  return { iv: ivBase64, encrypted: encryptedBase64 };
}

export async function decrypt(encryptedData: { iv: string; encrypted: string }, secret: string): Promise<string> {
  const iv = new Uint8Array(Array.from(atob(encryptedData.iv), c => c.charCodeAt(0)));
  const key = await getKey(secret, iv);

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
