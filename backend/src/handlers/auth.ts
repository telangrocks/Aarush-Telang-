// src/utils/auth.ts
import { sign } from "hono/jwt";
import { Context } from "hono";
import { Env } from "../index";

const ITERATIONS = 100000;
const HASH_ALGORITHM = "SHA-256";

const MIN_PASSWORD_LENGTH = 8;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 15;

export {
  ITERATIONS,
  HASH_ALGORITHM,
  MIN_PASSWORD_LENGTH,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCKOUT_MINUTES,
};

/**
 * Hashes a password using PBKDF2 with SHA-256.
 * Generates a random salt for each password and stores it with the hash.
 * @param password The plain-text password.
 * @returns A string containing the salt and hash, separated by a colon.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const key = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: ITERATIONS,
      hash: HASH_ALGORITHM,
    },
    keyMaterial,
    256,
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
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [saltString, hash] = storedHash.split(":");
  if (!saltString || !hash) {
    return false; // Invalid hash format
  }

  const salt = new Uint8Array(
    Array.from(atob(saltString), (c) => c.charCodeAt(0)),
  );
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const key = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: ITERATIONS,
      hash: HASH_ALGORITHM,
    },
    keyMaterial,
    256,
  );

  const newHash = new Uint8Array(key);
  const expectedHash = new Uint8Array(
    Array.from(atob(hash), (c) => c.charCodeAt(0)),
  );
  if (newHash.length !== expectedHash.length) {
    return false;
  }
  return timingSafeEqual(newHash, expectedHash);
}

/**
 * Constant-time byte-array comparison to prevent timing side-channel
 * attacks when verifying password hashes.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Checks if a JWT has been revoked.
 */
export async function isTokenRevoked(
  c: Context<{ Bindings: Env }>,
  jti: string,
): Promise<boolean> {
  const row = await c.env.DB.prepare(
    "SELECT jti FROM jwt_blacklist WHERE jti = ?",
  )
    .bind(jti)
    .first<{ jti: string }>();

  return !!row;
}

/**
 * Generates a JSON Web Token (JWT) for a user.
 * Includes a unique jti claim for revocation support.
 */
export async function generateJwt(
  userId: string,
  email: string,
  secret: string,
): Promise<string> {
  if (!secret || typeof secret !== "string") {
    throw new Error("JWT_SECRET is missing or invalid");
  }

  const jti = crypto.randomUUID();

  return sign(
    {
      sub: userId,
      email,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
      jti,
    }, // 7-day expiration
    secret,
  );
}
