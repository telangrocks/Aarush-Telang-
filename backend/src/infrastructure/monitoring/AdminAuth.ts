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
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
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

export async function sha256Hex(data: string): Promise<string> {
  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(data));
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function generateSecureToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface AdminSession {
  userId: string;
  email: string;
  role: 'ADMIN';
  authMethod: 'API_KEY' | 'JWT' | 'DEVICE_SESSION';
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

  // 3. Persistent Device Session (Cookie or Header)
  let deviceSessionToken: string | undefined;
  try {
    if (c.req?.raw?.headers) {
      deviceSessionToken = getCookie(c, 'cp_admin_device');
    }
  } catch (_) {
    // Graceful fallback if c.req.raw is not provided in mock contexts
  }
  if (!deviceSessionToken) {
    deviceSessionToken = c.req.header('x-device-session') || c.req.header('cookie')?.match(/cp_admin_device=([^;]+)/)?.[1];
  }

  if (deviceSessionToken && c.env.DB) {
    try {
      const tokenHash = await sha256Hex(deviceSessionToken.trim());
      const row = await c.env.DB.prepare(
        "SELECT session_id, device_name, expires_at, revoked_at FROM admin_device_sessions WHERE session_token_hash = ?"
      ).bind(tokenHash).first<{ session_id: string; device_name: string; expires_at: number; revoked_at: number | null }>();

      const now = Date.now();
      if (row && row.revoked_at === null && now <= row.expires_at) {
        c.set('adminSession' as any, {
          userId: `device_${row.session_id.slice(0, 8)}`,
          email: 'device@cryptopulse.internal',
          role: 'ADMIN',
          authMethod: 'DEVICE_SESSION'
        });
        return await next();
      }
    } catch (_) {
      // Fall through to 401
    }
  }

  // No admin key, token, or valid device session provided
  return c.json(
    {
      error: 'Unauthorized',
      message: 'Authentication required. Provide a valid X-Admin-Key, admin Bearer token, or authorized device session.'
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

    // Login path M: Master Dashboard Password authentication (sets 30-day device session & cookie)
    if (body.password && c.env.ADMIN_PASSWORD_HASH) {
      let isMasterValid = false;
      const hashes = c.env.ADMIN_PASSWORD_HASH.split(',');
      for (const h of hashes) {
        if (h.trim()) {
          try {
            if (await verifyPassword(body.password.trim(), h.trim())) {
              isMasterValid = true;
              break;
            }
          } catch (_) {}
        }
      }

      if (isMasterValid) {
        // Reset failed attempt counters on valid authentication
        await clearAdminLoginAttempts(c, ip);

        const now = Date.now();
        const nowSec = Math.floor(now / 1000);
        const sessionId = crypto.randomUUID();
        const sessionTokenBytes = new Uint8Array(32);
        crypto.getRandomValues(sessionTokenBytes);
        const sessionToken = Array.from(sessionTokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        const sessionTokenHash = await sha256Hex(sessionToken);
        const expiresAt = now + 30 * 24 * 60 * 60 * 1000;

        if (c.env.DB) {
          try {
            await c.env.DB.prepare(
              `INSERT INTO admin_device_sessions (session_id, device_name, session_token_hash, ip_address, created_at, last_used_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(sessionId, 'Personal Browser', sessionTokenHash, ip, now, now, expiresAt).run();
          } catch (dbErr) {
            console.error('[AdminAuth] Error storing device session:', dbErr);
          }
        }

        // Set Secure, HttpOnly, SameSite=None, Partitioned cookie
        try {
          if (typeof c.header === 'function') {
            setCookie(c, 'cp_admin_device', sessionToken, {
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: 'None',
              partitioned: true,
              maxAge: 30 * 24 * 3600
            });
          }
        } catch (_) {}

        const token = await sign(
          {
            sub: 'admin_operator',
            email: 'operator@cryptopulse.internal',
            role: 'ADMIN',
            sessionId,
            jti: crypto.randomUUID(),
            iat: nowSec,
            exp: nowSec + 8 * 3600 // 8 hours
          },
          jwtSecret,
          'HS256'
        );

        return c.json({
          success: true,
          token,
          deviceToken: sessionToken,
          expiresIn: 8 * 3600,
          user: {
            id: 'admin_operator',
            email: 'operator@cryptopulse.internal',
            role: 'ADMIN',
            deviceName: 'Personal Browser'
          }
        });
      }
    }

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

    await recordFailedAdminLogin(c, ip);
    return c.json({ error: 'Unauthorized', message: 'Invalid administrative credentials.' }, 401);
  } catch (err: any) {
    console.error('[AdminAuth] Login error:', err);
    return c.json({ error: 'Internal Error', message: err?.message || 'Login failed.' }, 500);
  }
}

/**
 * Handler: Generate a single-use, 15-minute activation token for zero-touch device enrollment.
 * Protected by adminAuthMiddleware.
 */
export async function handleCreateActivationToken(c: Context<{ Bindings: Env }>) {
  if (!c.env.DB) {
    return c.json({ error: 'Internal Error', message: 'D1 Database not available.' }, 500);
  }

  const rawToken = generateSecureToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const tokenId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + 15 * 60 * 1000; // 15 minutes strict expiry

  try {
    await c.env.DB.prepare(
      `INSERT INTO admin_activation_tokens (token_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?)`
    ).bind(tokenId, tokenHash, expiresAt, now).run();

    return c.json({
      success: true,
      activationToken: rawToken,
      expiresAt,
      expiresInSeconds: 900
    });
  } catch (err: any) {
    console.error('[AdminAuth] Error creating activation token:', err);
    return c.json({ error: 'Internal Error', message: 'Failed to create activation token.' }, 500);
  }
}

/**
 * Handler: One-click device activation.
 * Validates single-use token, consumes it atomically, registers device session,
 * and sets a Secure, HttpOnly, SameSite=None, Partitioned cookie.
 */
export async function handleActivateDevice(c: Context<{ Bindings: Env }>) {
  if (!c.env.DB) {
    return c.json({ error: 'Internal Error', message: 'D1 Database not available.' }, 500);
  }

  const csrfHeader = c.req.header('x-cryptopulse-admin');
  if (!csrfHeader) {
    return c.json({ error: 'Forbidden', message: 'CSRF security validation failed.' }, 403);
  }

  const body: { activationToken?: string; deviceName?: string } = (await c.req.json().catch(() => ({}))) as any;

  if (!body.activationToken || typeof body.activationToken !== 'string') {
    return c.json({ error: 'Bad Request', message: 'Missing activationToken.' }, 400);
  }

  const tokenHash = await sha256Hex(body.activationToken.trim());
  const now = Date.now();

  try {
    const row = await c.env.DB.prepare(
      `SELECT token_id, expires_at, used_at FROM admin_activation_tokens WHERE token_hash = ?`
    ).bind(tokenHash).first<{ token_id: string; expires_at: number; used_at: number | null }>();

    if (!row) {
      return c.json({ error: 'Unauthorized', message: 'Invalid activation token.' }, 401);
    }
    if (row.used_at !== null) {
      return c.json({ error: 'Unauthorized', message: 'Activation token has already been used.' }, 401);
    }
    if (now > row.expires_at) {
      return c.json({ error: 'Unauthorized', message: 'Activation token has expired.' }, 401);
    }

    // Atomically consume token so it cannot be reused
    const updateRes = await c.env.DB.prepare(
      `UPDATE admin_activation_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`
    ).bind(now, tokenHash).run();

    if (!updateRes.success || updateRes.meta?.changes === 0) {
      return c.json({ error: 'Unauthorized', message: 'Activation token already consumed.' }, 401);
    }

    // Create persistent device session
    const sessionToken = generateSecureToken(32);
    const sessionTokenHash = await sha256Hex(sessionToken);
    const sessionId = crypto.randomUUID();
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000; // 30-day rolling session
    const ip = getAdminClientIp(c);
    const deviceName = body.deviceName || 'Personal Browser';

    await c.env.DB.prepare(
      `INSERT INTO admin_device_sessions (
         session_id, device_name, session_token_hash, ip_address, created_at, last_used_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(sessionId, deviceName, sessionTokenHash, ip, now, now, expiresAt).run();

    // Generate 8-hour access JWT
    const jwtSecret = c.env.JWT_SECRET;
    const nowSec = Math.floor(now / 1000);
    const accessToken = await sign(
      {
        sub: 'admin_device_owner',
        email: 'operator@cryptopulse.internal',
        role: 'ADMIN',
        sessionId,
        iss: 'cryptopulse-monitoring',
        iat: nowSec,
        exp: nowSec + 8 * 3600
      },
      jwtSecret,
      'HS256'
    );

    // Set Secure, HttpOnly, SameSite=None, Partitioned cookie
    try {
      if (typeof c.header === 'function') {
        setCookie(c, 'cp_admin_device', sessionToken, {
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'None',
          partitioned: true,
          maxAge: 30 * 24 * 3600
        });
      }
    } catch (_) {}

    return c.json({
      success: true,
      accessToken,
      deviceToken: sessionToken,
      expiresIn: 8 * 3600,
      user: {
        id: 'admin_device_owner',
        email: 'operator@cryptopulse.internal',
        role: 'ADMIN',
        deviceName
      }
    });
  } catch (err: any) {
    console.error('[AdminAuth] Error activating device:', err);
    return c.json({ error: 'Internal Error', message: 'Device activation failed.' }, 500);
  }
}

/**
 * Handler: Silent rolling session renewal.
 * Validates persistent cookie or device session header, verifies non-revocation in D1,
 * and rolls session forward 30 days while returning a fresh short-lived JWT.
 */
export async function handleRefreshDeviceSession(c: Context<{ Bindings: Env }>) {
  if (!c.env.DB) {
    return c.json({ error: 'Internal Error', message: 'D1 Database not available.' }, 500);
  }

  const csrfHeader = c.req.header('x-cryptopulse-admin');
  if (!csrfHeader) {
    return c.json({ error: 'Forbidden', message: 'CSRF security validation failed.' }, 403);
  }

  let tokenFromCookie: string | undefined;
  try {
    if (c.req?.raw?.headers) {
      tokenFromCookie = getCookie(c, 'cp_admin_device');
    }
  } catch (_) {}

  const tokenFromHeader = c.req.header('x-device-session') || c.req.header('cookie')?.match(/cp_admin_device=([^;]+)/)?.[1];
  let tokenFromBody: string | undefined;

  if (c.req.header('content-type')?.includes('application/json')) {
    const body = await c.req.json().catch(() => ({}));
    tokenFromBody = body?.deviceToken;
  }

  const rawSessionToken = tokenFromCookie || tokenFromHeader || tokenFromBody;
  if (!rawSessionToken) {
    return c.json({ error: 'Unauthorized', message: 'No device session found.' }, 401);
  }

  const tokenHash = await sha256Hex(rawSessionToken.trim());
  const now = Date.now();

  try {
    const row = await c.env.DB.prepare(
      `SELECT session_id, device_name, expires_at, revoked_at FROM admin_device_sessions WHERE session_token_hash = ?`
    ).bind(tokenHash).first<{ session_id: string; device_name: string; expires_at: number; revoked_at: number | null }>();

    if (!row || row.revoked_at !== null) {
      try {
        if (typeof c.header === 'function') {
          c.header('Set-Cookie', 'cp_admin_device=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0', { append: true });
        }
      } catch (_) {}
      return c.json({ error: 'Unauthorized', message: 'Device session has been revoked or does not exist.' }, 401);
    }

    if (now > row.expires_at) {
      try {
        if (typeof c.header === 'function') {
          c.header('Set-Cookie', 'cp_admin_device=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0', { append: true });
        }
      } catch (_) {}
      return c.json({ error: 'Unauthorized', message: 'Device session has expired.' }, 401);
    }

    // Roll forward session expiry by 30 days
    const newExpiresAt = now + 30 * 24 * 60 * 60 * 1000;
    await c.env.DB.prepare(
      `UPDATE admin_device_sessions SET last_used_at = ?, expires_at = ? WHERE session_id = ?`
    ).bind(now, newExpiresAt, row.session_id).run();

    // Generate fresh 8-hour access JWT
    const jwtSecret = c.env.JWT_SECRET;
    const nowSec = Math.floor(now / 1000);
    const accessToken = await sign(
      {
        sub: 'admin_device_owner',
        email: 'operator@cryptopulse.internal',
        role: 'ADMIN',
        sessionId: row.session_id,
        iss: 'cryptopulse-monitoring',
        iat: nowSec,
        exp: nowSec + 8 * 3600
      },
      jwtSecret,
      'HS256'
    );

    // Refresh HttpOnly cookie
    try {
      if (typeof c.header === 'function') {
        setCookie(c, 'cp_admin_device', rawSessionToken.trim(), {
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'None',
          partitioned: true,
          maxAge: 30 * 24 * 3600
        });
      }
    } catch (_) {}

    return c.json({
      success: true,
      accessToken,
      deviceToken: rawSessionToken.trim(),
      expiresIn: 8 * 3600,
      user: {
        id: 'admin_device_owner',
        email: 'operator@cryptopulse.internal',
        role: 'ADMIN',
        deviceName: row.device_name
      }
    });
  } catch (err: any) {
    console.error('[AdminAuth] Error refreshing device session:', err);
    return c.json({ error: 'Internal Error', message: 'Failed to refresh session.' }, 500);
  }
}

/**
 * Handler: Revoke active device session immediately.
 */
export async function handleRevokeDeviceSession(c: Context<{ Bindings: Env }>) {
  if (!c.env.DB) {
    return c.json({ error: 'Internal Error', message: 'D1 Database not available.' }, 500);
  }

  let tokenFromCookie: string | undefined;
  try {
    if (c.req?.raw?.headers) {
      tokenFromCookie = getCookie(c, 'cp_admin_device');
    }
  } catch (_) {}

  const tokenFromHeader = c.req.header('x-device-session') || c.req.header('cookie')?.match(/cp_admin_device=([^;]+)/)?.[1];
  let tokenFromBody: string | undefined;

  if (c.req.header('content-type')?.includes('application/json')) {
    const body = await c.req.json().catch(() => ({}));
    tokenFromBody = body?.deviceToken;
  }

  const rawSessionToken = tokenFromCookie || tokenFromHeader || tokenFromBody;
  if (rawSessionToken) {
    try {
      const tokenHash = await sha256Hex(rawSessionToken.trim());
      await c.env.DB.prepare(
        `UPDATE admin_device_sessions SET revoked_at = ? WHERE session_token_hash = ?`
      ).bind(Date.now(), tokenHash).run();
    } catch (_) {}
  }

  try {
    if (typeof c.header === 'function') {
      c.header('Set-Cookie', 'cp_admin_device=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0', { append: true });
    }
  } catch (_) {}
  return c.json({ success: true, message: 'Device session revoked successfully.' });
  return c.json({ success: true, message: 'Device session revoked successfully.' });
}
