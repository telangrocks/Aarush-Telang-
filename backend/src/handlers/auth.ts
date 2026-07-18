// src/utils/auth.ts
import { sign, verify } from "hono/jwt";
import { Context } from "hono";
import { Env } from "../index";

const ITERATIONS = 100000;
const HASH_ALGORITHM = "SHA-256";

const MIN_PASSWORD_LENGTH = 8;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 15;
const ACCESS_TOKEN_EXPIRY_SECONDS = 60 * 15; // 15 minutes
const REFRESH_TOKEN_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_ACTIVE_REFRESH_TOKENS = 5;

export {
  ITERATIONS,
  HASH_ALGORITHM,
  MIN_PASSWORD_LENGTH,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCKOUT_MINUTES,
  ACCESS_TOKEN_EXPIRY_SECONDS,
  REFRESH_TOKEN_EXPIRY_SECONDS,
  MAX_ACTIVE_REFRESH_TOKENS,
};

export type D1Statement = {
  sql: string;
  bindings: unknown[];
};

export async function runTransaction(
  c: Context<{ Bindings: Env }>,
  statements: D1Statement[],
): Promise<void> {
  if (statements.length === 0) return;
  const prepared = statements.map((stmt) =>
    c.env.DB.prepare(stmt.sql).bind(...stmt.bindings),
  );

  if (typeof (c.env.DB as any).batch === "function") {
    await (c.env.DB as any).batch(prepared);
  } else {
    for (const stmt of prepared) {
      await stmt.run();
    }
  }
}

export async function createAuditLog(
  c: Context<{ Bindings: Env }>,
  params: {
    userId?: string;
    action: string;
    ip?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata = params.metadata ? JSON.stringify(params.metadata) : null;

    await c.env.DB.prepare(
      "INSERT INTO audit_log (id, user_id, action, ip, user_agent, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, params.userId || null, params.action, params.ip || null, params.userAgent || null, metadata, now)
      .run();
  } catch {
    // Audit logging should not break the main flow
  }
}

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
 * Generates an access JWT for a user (short-lived, 15 minutes).
 */
export async function generateAccessToken(
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
      exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_EXPIRY_SECONDS,
      jti,
      type: "access",
    },
    secret,
  );
}

/**
 * Generates a refresh token for a user (long-lived, 7 days).
 */
export async function generateRefreshToken(
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
      exp: Math.floor(Date.now() / 1000) + REFRESH_TOKEN_EXPIRY_SECONDS,
      jti,
      type: "refresh",
    },
    secret,
  );
}

/**
 * Stores a refresh token in the database.
 */
export async function storeRefreshToken(
  c: Context<{ Bindings: Env }>,
  jti: string,
  userId: string,
  expiresAt: number,
): Promise<void> {
  await c.env.DB.prepare(
    "INSERT INTO refresh_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)",
  )
    .bind(jti, userId, expiresAt)
    .run();
}

/**
 * Revokes a refresh token.
 */
export async function revokeRefreshToken(
  c: Context<{ Bindings: Env }>,
  jti: string,
): Promise<void> {
  await c.env.DB.prepare(
    "UPDATE refresh_tokens SET revoked = 1 WHERE jti = ?",
  )
    .bind(jti)
    .run();
}

/**
 * Validates a refresh token and returns the payload if valid.
 */
export async function validateRefreshToken(
  c: Context<{ Bindings: Env }>,
  token: string,
  secret: string,
): Promise<{ sub: string; email: string; jti: string } | null> {
  try {
    const payload = await verify(token, secret, { alg: "HS256" });
    if (!payload || typeof payload !== "object") return null;
    if ((payload as any).type !== "refresh") return null;

    const jti = (payload as any).jti as string;
    const row = await c.env.DB.prepare(
      "SELECT jti, revoked, expires_at FROM refresh_tokens WHERE jti = ?",
    )
      .bind(jti)
      .first<{ jti: string; revoked: number; expires_at: number }>();

    if (!row || row.revoked === 1 || row.expires_at < Date.now() / 1000) {
      return null;
    }

    return {
      sub: (payload as any).sub as string,
      email: (payload as any).email as string,
      jti,
    };
  } catch {
    return null;
  }
}

/**
 * Decodes the payload of a JWT without verifying the signature.
 * Returns the parsed JSON payload or null on failure.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64);
    return JSON.parse(json);
  } catch {
    return null;
  }
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
 * Revokes all active refresh tokens for a user.
 */
export async function revokeAllUserRefreshTokens(
  c: Context<{ Bindings: Env }>,
  userId: string,
): Promise<void> {
  await c.env.DB.prepare(
    "UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0",
  )
    .bind(userId)
    .run();
}

/**
 * Counts active (non-revoked, non-expired) refresh tokens for a user.
 */
export async function countActiveRefreshTokens(
  c: Context<{ Bindings: Env }>,
  userId: string,
): Promise<number> {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM refresh_tokens
     WHERE user_id = ? AND revoked = 0 AND expires_at > ?`,
  )
    .bind(userId, Math.floor(Date.now() / 1000))
    .first<{ count: number }>();

  return row?.count ?? 0;
}
