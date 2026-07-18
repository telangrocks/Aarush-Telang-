// src/handlers/user.ts
import { Context } from "hono";
import { Env } from "../index";
import {
  hashPassword,
  verifyPassword,
  generateJwt,
  isTokenRevoked,
  MIN_PASSWORD_LENGTH,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCKOUT_MINUTES,
} from "./auth";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/;

const MAX_REGISTRATIONS_PER_WINDOW = 10;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

function isValidPassword(password: string): boolean {
  return (
    password.length >= MIN_PASSWORD_LENGTH &&
    PASSWORD_REGEX.test(password)
  );
}

function logAuthEvent(event: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...details }));
}

function getClientIp(c: Context<{ Bindings: Env }>): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Throttles account creation to at most MAX_REGISTRATIONS_PER_WINDOW
 * attempts per client IP per REGISTRATION_WINDOW_MS window.
 * Returns true if the registration is allowed to proceed.
 */
async function isRegistrationAllowed(
  c: Context<{ Bindings: Env }>,
): Promise<boolean> {
  const ip = getClientIp(c);
  const now = Date.now();

  const row = await c.env.DB.prepare(
    "SELECT count, window_start FROM registration_attempts WHERE ip = ?",
  )
    .bind(ip)
    .first<{ count: number; window_start: number }>();

  if (!row || now - row.window_start >= REGISTRATION_WINDOW_MS) {
    await c.env.DB.prepare(
      `INSERT INTO registration_attempts (ip, count, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT(ip) DO UPDATE SET
         count = 1,
         window_start = excluded.window_start`,
    )
      .bind(ip, now)
      .run();
    return true;
  }

  if (row.count >= MAX_REGISTRATIONS_PER_WINDOW) {
    return false;
  }

  await c.env.DB.prepare(
    "UPDATE registration_attempts SET count = count + 1 WHERE ip = ?",
  )
    .bind(ip)
    .run();
  return true;
}

/**
 * Handles the user registration request.
 * Creates an ACTIVE user immediately using email + password only.
 */
export async function handleRegister(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const { email, password, confirmPassword } = await c.req.json<{
      email?: string;
      password?: string;
      confirmPassword?: string;
    }>();

    if (!(await isRegistrationAllowed(c))) {
      logAuthEvent("registration_rate_limited", {
        ip: getClientIp(c),
      });
      c.status(429);
      return c.json({
        error: "Too many registration attempts. Please try again later.",
      });
    }

    const normalizedEmail = email ? normalizeEmail(email) : "";
    if (
      !normalizedEmail ||
      !isValidEmail(normalizedEmail) ||
      !password ||
      !confirmPassword ||
      password !== confirmPassword ||
      !isValidPassword(password)
    ) {
      c.status(400);
      return c.json({
        error:
          "Invalid input. A valid email is required, password must be at least 8 characters with uppercase, lowercase, number, and special character, and passwords must match.",
      });
    }

    const existingUser = await c.env.DB.prepare(
      "SELECT status FROM users WHERE email = ?",
    )
      .bind(normalizedEmail)
      .first<{ status: string | null }>();

    if (existingUser?.status === "ACTIVE") {
      c.status(409);
      return c.json({
        error: "An active user with this email already exists.",
      });
    }

    const hashedPassword = await hashPassword(password);
    const now = new Date().toISOString();

    await c.env.DB.prepare(
      `INSERT INTO users (
         id,
         email,
         password_hash,
         created_at,
         status,
         updated_at,
         failed_login_attempts,
         locked_until
       )
       VALUES (?, ?, ?, ?, 'ACTIVE', ?, 0, NULL)
       ON CONFLICT(email) DO UPDATE SET
         password_hash = excluded.password_hash,
         status = 'ACTIVE',
         updated_at = excluded.updated_at,
         failed_login_attempts = 0,
         locked_until = NULL`,
    )
      .bind(crypto.randomUUID(), normalizedEmail, hashedPassword, now, now)
      .run();

    const user = await c.env.DB.prepare(
      "SELECT id, email FROM users WHERE email = ?",
    )
      .bind(normalizedEmail)
      .first<{ id: string; email: string }>();

    if (!user) {
      throw new Error("Failed to load registered user.");
    }

    logAuthEvent("user_registered", { userId: user.id, email: user.email });

    const token = await generateJwt(user.id, user.email, c.env.JWT_SECRET);
    c.status(200);
    return c.json({
      message: "Account created successfully.",
      token,
    });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Registration error:", error);
    c.status(500);
    return c.json({
      error: "An internal server error occurred.",
      message: error.message,
    });
  }
}

/**
 * OTP resend is disabled while the app uses direct email + password auth.
 */
export async function handleResendOtp(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  c.status(410);
  return c.json({
    error: "OTP email verification is currently disabled.",
  });
}

/**
 * Handles the user login request.
 * Verifies credentials and returns a JWT on success.
 */
export async function handleLogin(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const { email, password } = await c.req.json<{
      email?: string;
      password?: string;
    }>();
    const normalizedEmail = email ? normalizeEmail(email) : "";

    if (!normalizedEmail || !password) {
      c.status(400);
      return c.json({ error: "Email and password are required." });
    }

    const user = await c.env.DB.prepare(
      "SELECT id, email, password_hash, status, failed_login_attempts, locked_until FROM users WHERE email = ?",
    )
      .bind(normalizedEmail)
      .first<{
        id: string;
        email: string;
        password_hash: string;
        status: string | null;
        failed_login_attempts: number | null;
        locked_until: number | null;
      }>();

    if (!user) {
      logAuthEvent("login_failed", { email: normalizedEmail, reason: "user_not_found" });
      c.status(401);
      return c.json({ error: "Invalid credentials." });
    }

    if (user.locked_until && user.locked_until > Date.now()) {
      logAuthEvent("login_failed", { userId: user.id, email: user.email, reason: "account_locked" });
      c.status(429);
      return c.json({
        error: "Account temporarily locked due to too many failed attempts. Please try again later.",
      });
    }

    const isPasswordValid = await verifyPassword(password, user.password_hash);
    if (!isPasswordValid) {
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      const shouldLock = newAttempts >= MAX_LOGIN_ATTEMPTS;
      const lockedUntil = shouldLock
        ? Date.now() + LOGIN_LOCKOUT_MINUTES * 60 * 1000
        : null;

      await c.env.DB.prepare(
        "UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?",
      )
        .bind(newAttempts, lockedUntil, user.id)
        .run();

      logAuthEvent("login_failed", { userId: user.id, email: user.email, reason: "invalid_password", attempts: newAttempts });
      c.status(401);
      return c.json({ error: "Invalid credentials." });
    }

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      "UPDATE users SET status = 'ACTIVE', failed_login_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?",
    )
      .bind(now, user.id)
      .run();

    logAuthEvent("login_success", { userId: user.id, email: user.email });

    const token = await generateJwt(user.id, user.email, c.env.JWT_SECRET);
    c.status(200);
    return c.json({ token });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Login error:", error);
    c.status(500);
    return c.json({
      error: "An internal server error occurred.",
      message: error.message,
    });
  }
}

/**
 * OTP verification is disabled while the app uses direct email + password auth.
 */
export async function handleVerifyOtp(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  c.status(410);
  return c.json({
    error: "OTP email verification is currently disabled.",
  });
}

/**
 * Handles fetching the authenticated user's profile.
 * This is a protected route and expects a valid JWT.
 */
export async function handleGetProfile(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    if (!payload || !payload.sub) {
      c.status(401);
      return c.json({
        error: "Unauthorized",
        message: "Invalid token payload.",
      });
    }

    const userId = payload.sub;
    const user = await c.env.DB.prepare(
      "SELECT id, email, created_at FROM users WHERE id = ?",
    )
      .bind(userId)
      .first();

    if (!user) {
      c.status(404);
      return c.json({ error: "User not found." });
    }

    return c.json(user);
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Get profile error:", error);
    c.status(500);
    return c.json({
      error: "An internal server error occurred.",
      message: error.message,
    });
  }
}

/**
 * Revokes a JWT by adding its jti to the blacklist.
 */
async function revokeToken(
  c: Context<{ Bindings: Env }>,
  jti: string,
  userId: string,
  expiresAt: number,
): Promise<void> {
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO jwt_blacklist (jti, user_id, expires_at) VALUES (?, ?, ?)",
  )
    .bind(jti, userId, expiresAt)
    .run();
}

/**
 * Handles user logout by revoking the current JWT and clearing FCM token.
 */
export async function handleLogout(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string; jti?: string } | undefined;
    if (!payload || !payload.sub) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const userId = payload.sub;
    const jti = payload.jti || crypto.randomUUID();

    await revokeToken(c, jti, userId, Date.now() / 1000 + 60 * 60 * 24 * 7);

    await c.env.DB.prepare(
      "UPDATE users SET fcm_token = NULL WHERE id = ?",
    )
      .bind(userId)
      .run();

    logAuthEvent("user_logout", { userId });

    return c.json({ success: true, message: "Logged out successfully" });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Logout error:", error);
    c.status(500);
    return c.json({ error: "An internal server error occurred.", message: error.message });
  }
}

/**
 * Handles deleting the FCM token for the current user.
 */
export async function handleDeleteFcmToken(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    if (!payload || !payload.sub) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const userId = payload.sub;

    await c.env.DB.prepare(
      "UPDATE users SET fcm_token = NULL WHERE id = ?",
    )
      .bind(userId)
      .run();

    return c.json({ success: true, message: "FCM token removed" });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Delete FCM token error:", error);
    c.status(500);
    return c.json({ error: "An internal server error occurred.", message: error.message });
  }
}
