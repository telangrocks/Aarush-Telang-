/**
 * AdminAuth.ts
 *
 * Dedicated administrative authorization boundary for CryptoPulse Centralized Monitoring.
 *
 * Security Invariants:
 * - Constant-time comparison for API keys.
 * - Multi-layer role verification (JWT claims, D1 user role, or explicit ADMIN_API_KEY).
 * - Zero leakage of passwords, salts, or exchange secrets on admin endpoints.
 * - Never grants access to regular non-admin user JWTs.
 */

import { Context, Next } from 'hono';
import { verify, sign } from 'hono/jwt';
import { Env } from '../../index';
import { verifyPassword } from '../../handlers/auth';

/**
 * Timing-safe string comparison to protect against side-channel timing attacks.
 */
export function timingSafeStringCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface AdminSession {
  userId: string;
  email: string;
  role: 'ADMIN';
  authMethod: 'API_KEY' | 'JWT';
}

export const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
export const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

interface RateLimitRecord {
  count: number;
  windowStart: number;
}
const memoryRateLimiter = new Map<string, RateLimitRecord>();
const MAX_MEM_IPS = 1000;

export function resetAdminRateLimiterForTesting(): void {
  memoryRateLimiter.clear();
}

export function getAdminClientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "127.0.0.1"
  );
}

export async function isAdminLoginAllowed(c: Context<{ Bindings: Env }>, ip: string): Promise<boolean> {
  const now = Date.now();
  const rateKey = `admin_login:${ip}`;

  // 1. Check in-memory fast cache
  const memRecord = memoryRateLimiter.get(rateKey);
  if (memRecord && now - memRecord.windowStart < ADMIN_LOGIN_WINDOW_MS) {
    if (memRecord.count >= ADMIN_LOGIN_MAX_ATTEMPTS) {
      return false;
    }
  }

  // 2. Check D1 login_attempts table (global across edge isolates)
  if (c.env.DB) {
    try {
      const row = await c.env.DB.prepare(
        "SELECT count, window_start FROM login_attempts WHERE ip = ?"
      )
        .bind(rateKey)
        .first<{ count: number; window_start: number }>();

      if (row && now - row.window_start < ADMIN_LOGIN_WINDOW_MS) {
        if (row.count >= ADMIN_LOGIN_MAX_ATTEMPTS) {
          return false;
        }
      }
    } catch (_) {
      // Graceful fallback to in-memory state
    }
  }

  return true;
}

export async function recordFailedAdminLogin(c: Context<{ Bindings: Env }>, ip: string): Promise<void> {
  const now = Date.now();
  const rateKey = `admin_login:${ip}`;

  // Update in-memory
  const mem = memoryRateLimiter.get(rateKey);
  if (!mem || now - mem.windowStart >= ADMIN_LOGIN_WINDOW_MS) {
    if (memoryRateLimiter.size >= MAX_MEM_IPS) {
      const oldestKey = memoryRateLimiter.keys().next().value;
      if (oldestKey) memoryRateLimiter.delete(oldestKey);
    }
    memoryRateLimiter.set(rateKey, { count: 1, windowStart: now });
  } else {
    mem.count++;
  }

  // Update D1
  if (c.env.DB) {
    try {
      const row = await c.env.DB.prepare(
        "SELECT count, window_start FROM login_attempts WHERE ip = ?"
      )
        .bind(rateKey)
        .first<{ count: number; window_start: number }>();

      if (!row || now - row.window_start >= ADMIN_LOGIN_WINDOW_MS) {
        await c.env.DB.prepare(
          `INSERT INTO login_attempts (ip, count, window_start)
           VALUES (?, 1, ?)
           ON CONFLICT(ip) DO UPDATE SET count = 1, window_start = excluded.window_start`
        )
          .bind(rateKey, now)
          .run();
      } else {
        await c.env.DB.prepare(
          "UPDATE login_attempts SET count = count + 1 WHERE ip = ?"
        )
          .bind(rateKey)
          .run();
      }
    } catch (_) {
      // Swallow error
    }
  }
}

export async function clearAdminLoginAttempts(c: Context<{ Bindings: Env }>, ip: string): Promise<void> {
  const rateKey = `admin_login:${ip}`;
  memoryRateLimiter.delete(rateKey);
  if (c.env.DB) {
    try {
      await c.env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?")
        .bind(rateKey)
        .run();
    } catch (_) {}
  }
}

/**
 * Middleware: Strictly enforces admin authentication on monitoring routes.
 */
export async function adminAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const adminKey = c.req.header('X-Admin-Key') || c.req.header('x-admin-key');
  const authHeader = c.req.header('Authorization') || c.req.header('authorization');

  const configuredKey = c.env.ADMIN_API_KEY || (c.env as any).MONITORING_ADMIN_KEY;

  // 1. Direct Admin API Key verification
  if (adminKey && configuredKey) {
    const isKeyValid = timingSafeStringCompare(adminKey.trim(), configuredKey.trim());
    if (isKeyValid) {
      c.set('adminSession' as any, {
        userId: 'admin_key_operator',
        email: 'operator@cryptopulse.internal',
        role: 'ADMIN',
        authMethod: 'API_KEY'
      });
      return await next();
    }
  }

  // 2. Admin Bearer Token verification
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const jwtSecret = c.env.JWT_SECRET;

    if (!jwtSecret) {
      return c.json({ error: 'Internal Error', message: 'JWT_SECRET not configured on backend.' }, 500);
    }

    try {
      const payload = await verify(token, jwtSecret, "HS256");

      // Explicit role claim in token
      if (payload.role === 'ADMIN') {
        c.set('adminSession' as any, {
          userId: String(payload.sub),
          email: String(payload.email || 'admin@cryptopulse.app'),
          role: 'ADMIN',
          authMethod: 'JWT'
        });
        return await next();
      }

      // Check configured admin emails list
      const adminEmailsStr = (c.env as any).ADMIN_EMAILS;
      if (adminEmailsStr && typeof payload.email === 'string') {
        const allowed = adminEmailsStr.split(',').map((e: string) => e.trim().toLowerCase());
        if (allowed.includes(payload.email.toLowerCase())) {
          c.set('adminSession' as any, {
            userId: String(payload.sub),
            email: String(payload.email),
            role: 'ADMIN',
            authMethod: 'JWT'
          });
          return await next();
        }
      }

      // Check D1 users table for role column if present
      if (payload.sub && c.env.DB) {
        try {
          const userRow = await c.env.DB.prepare('SELECT role, email FROM users WHERE id = ?')
            .bind(payload.sub)
            .first<{ role?: string; email?: string }>();

          if (userRow?.role === 'ADMIN') {
            c.set('adminSession' as any, {
              userId: String(payload.sub),
              email: String(userRow.email || payload.email),
              role: 'ADMIN',
              authMethod: 'JWT'
            });
            return await next();
          }
        } catch (_) {
          // If role column not yet created in table, gracefully continue to 403
        }
      }

      // Token is valid but user lacks admin privilege
      return c.json(
        {
          error: 'Forbidden',
          message: 'Access denied: Administrative privileges required to access monitoring APIs.'
        },
        403
      );
    } catch (_) {
      return c.json({ error: 'Unauthorized', message: 'Invalid or expired administrative token.' }, 401);
    }
  }

  // No admin key or token provided
  return c.json(
    {
      error: 'Unauthorized',
      message: 'Authentication required. Provide a valid X-Admin-Key or admin Bearer token.'
    },
    401
  );
}

/**
 * Handler: Dedicated login endpoint for Admin Monitoring Dashboard.
 */
export async function handleAdminLogin(c: Context<{ Bindings: Env }>) {
  try {
    const ip = getAdminClientIp(c);

    // 0. Enforce Brute-Force Rate Limiting (max 5 failed attempts per 15 minutes)
    if (!(await isAdminLoginAllowed(c, ip))) {
      return c.json(
        {
          error: 'Too Many Requests',
          message: 'Too many failed administrator login attempts. Access is temporarily locked for 15 minutes.'
        },
        429
      );
    }

    const body = await c.req.json<{
      email?: string;
      password?: string;
      adminKey?: string;
    }>();

    const jwtSecret = c.env.JWT_SECRET;
    if (!jwtSecret) {
      return c.json({ error: 'Internal Error', message: 'Backend JWT_SECRET is not configured.' }, 500);
    }

    const configuredKey = c.env.ADMIN_API_KEY || (c.env as any).MONITORING_ADMIN_KEY;

    // Login path A: Direct Admin Key authentication
    if (body.adminKey && configuredKey) {
      const isKeyValid = timingSafeStringCompare(body.adminKey.trim(), configuredKey.trim());
      if (isKeyValid) {
        // Reset failed attempt counters on valid authentication
        await clearAdminLoginAttempts(c, ip);

        const nowSec = Math.floor(Date.now() / 1000);
        const token = await sign(
          {
            sub: 'admin_operator',
            email: 'operator@cryptopulse.internal',
            role: 'ADMIN',
            jti: crypto.randomUUID(),
            iat: nowSec,
            exp: nowSec + 8 * 3600 // 8 hours
          },
          jwtSecret
        );

        return c.json({
          success: true,
          token,
          expiresIn: 8 * 3600,
          user: {
            id: 'admin_operator',
            email: 'operator@cryptopulse.internal',
            role: 'ADMIN'
          }
        });
      }

      await recordFailedAdminLogin(c, ip);
      return c.json({ error: 'Unauthorized', message: 'Invalid administrator key.' }, 401);
    }

    // Login path B: User Email & Password authentication with admin authorization
    if (body.email && body.password) {
      const email = body.email.trim().toLowerCase();

      if (!c.env.DB) {
        return c.json({ error: 'Service Unavailable', message: 'Database binding unavailable.' }, 503);
      }

      const user = await c.env.DB.prepare(
        'SELECT id, email, password_hash, password_salt, role FROM users WHERE email = ?'
      )
        .bind(email)
        .first<{ id: string; email: string; password_hash: string; password_salt: string; role?: string }>();

      if (!user) {
        await recordFailedAdminLogin(c, ip);
        return c.json({ error: 'Unauthorized', message: 'Invalid credentials.' }, 401);
      }

      const isPasswordValid = await verifyPassword(body.password, user.password_hash);
      if (!isPasswordValid) {
        await recordFailedAdminLogin(c, ip);
        return c.json({ error: 'Unauthorized', message: 'Invalid credentials.' }, 401);
      }

      // Check admin authorization
      const adminEmails = (c.env as any).ADMIN_EMAILS
        ? (c.env as any).ADMIN_EMAILS.split(',').map((e: string) => e.trim().toLowerCase())
        : [];

      const isAdmin = user.role === 'ADMIN' || adminEmails.includes(email);

      if (!isAdmin) {
        await recordFailedAdminLogin(c, ip);
        return c.json(
          {
            error: 'Forbidden',
            message: 'User account does not possess administrative privileges.'
          },
          403
        );
      }

      // Reset failed attempt counters on valid authentication
      await clearAdminLoginAttempts(c, ip);

      const nowSec = Math.floor(Date.now() / 1000);
      const token = await sign(
        {
          sub: user.id,
          email: user.email,
          role: 'ADMIN',
          jti: crypto.randomUUID(),
          iat: nowSec,
          exp: nowSec + 8 * 3600
        },
        jwtSecret
      );

      return c.json({
        success: true,
        token,
        expiresIn: 8 * 3600,
        user: {
          id: user.id,
          email: user.email,
          role: 'ADMIN'
        }
      });
    }

    return c.json({ error: 'Bad Request', message: 'Provide email & password or valid adminKey.' }, 400);
  } catch (err: any) {
    console.error('[AdminAuth] Login error:', err);
    return c.json({ error: 'Internal Error', message: err?.message || 'Login failed.' }, 500);
  }
}
