// src/utils/crypto.ts

async function getKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new Uint8Array(16), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function encrypt(text: string, secret: string): Promise<{ iv: string; encrypted: string }> {
  const key = await getKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);

  const encryptedContent = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encoded
  );

  const encryptedBase64 = btoa(String.fromCharCode(...new Uint8Array(encryptedContent)));
  const ivBase64 = btoa(String.fromCharCode(...iv));

  return { iv: ivBase64, encrypted: encryptedBase64 };
}

export async function decrypt(encryptedData: { iv: string; encrypted: string }, secret: string): Promise<string> {
  const key = await getKey(secret);

  const iv = new Uint8Array(Array.from(atob(encryptedData.iv), c => c.charCodeAt(0)));
  const encrypted = new Uint8Array(Array.from(atob(encryptedData.encrypted), c => c.charCodeAt(0)));

  const decryptedContent = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv,
    },
    key,
    encrypted
  );

  return new TextDecoder().decode(decryptedContent);
}