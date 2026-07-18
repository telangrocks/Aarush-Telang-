// src/handlers/user.ts
import { Context } from "hono";
import { Env } from "../index";
import {
  hashPassword,
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  storeRefreshToken,
  revokeRefreshToken,
  validateRefreshToken,
  decodeJwtPayload,
  revokeAllUserRefreshTokens,
  countActiveRefreshTokens,
  MIN_PASSWORD_LENGTH,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCKOUT_MINUTES,
  MAX_ACTIVE_REFRESH_TOKENS,
} from "./auth";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/;

const MAX_REGISTRATIONS_PER_WINDOW = 10;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;

const MAX_LOGIN_ATTEMPTS_PER_IP = 20;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

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
 * Throttles account creation atomically to prevent race conditions.
 */
async function isRegistrationAllowed(
  c: Context<{ Bindings: Env }>,
): Promise<boolean> {
  const ip = getClientIp(c);
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO registration_attempts (ip, count, window_start)
     VALUES (?, 1, ?)
     ON CONFLICT(ip) DO UPDATE SET
       count = CASE WHEN excluded.window_start > window_start THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN excluded.window_start > window_start THEN excluded.window_start ELSE window_start END`,
  )
    .bind(ip, now)
    .run();

  const row = await c.env.DB.prepare(
    "SELECT count, window_start FROM registration_attempts WHERE ip = ?",
  )
    .bind(ip)
    .first<{ count: number; window_start: number }>();

  if (!row || now - row.window_start >= REGISTRATION_WINDOW_MS) {
    return true;
  }

  return row.count < MAX_REGISTRATIONS_PER_WINDOW;
}

/**
 * Throttles login attempts per IP atomically.
 */
async function isLoginAllowed(
  c: Context<{ Bindings: Env }>,
): Promise<boolean> {
  const ip = getClientIp(c);
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO login_attempts (ip, count, window_start)
     VALUES (?, 1, ?)
     ON CONFLICT(ip) DO UPDATE SET
       count = CASE WHEN excluded.window_start > window_start THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN excluded.window_start > window_start THEN excluded.window_start ELSE window_start END`,
  )
    .bind(ip, now)
    .run();

  const row = await c.env.DB.prepare(
    "SELECT count, window_start FROM login_attempts WHERE ip = ?",
  )
    .bind(ip)
    .first<{ count: number; window_start: number }>();

  if (!row || now - row.window_start >= LOGIN_RATE_LIMIT_WINDOW_MS) {
    return true;
  }

  return row.count < MAX_LOGIN_ATTEMPTS_PER_IP;
}

/**
 * Handles the user registration request.
 * Creates a PENDING_VERIFICATION user and sends OTP (simulated for now).
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
      "SELECT id, status FROM users WHERE email = ?",
    )
      .bind(normalizedEmail)
      .first<{ id: string; status: string }>();

    if (existingUser?.status === "ACTIVE") {
      c.status(409);
      return c.json({
        error: "An active user with this email already exists.",
      });
    }

    const hashedPassword = await hashPassword(password);
    const now = new Date().toISOString();

    if (existingUser) {
      await c.env.DB.prepare(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
      )
        .bind(hashedPassword, now, existingUser.id)
        .run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO users (id, email, password_hash, created_at, status, updated_at, failed_login_attempts, locked_until)
         VALUES (?, ?, ?, ?, 'PENDING_VERIFICATION', ?, 0, NULL)`,
      )
        .bind(crypto.randomUUID(), normalizedEmail, hashedPassword, now, now)
        .run();
    }

    logAuthEvent("user_registered", { email: normalizedEmail });

    c.status(200);
    return c.json({
      message: "Account created successfully. Please verify your email.",
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
 * Verifies credentials and returns an access token + refresh token.
 */
export async function handleLogin(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    if (!(await isLoginAllowed(c))) {
      logAuthEvent("login_rate_limited", {
        ip: getClientIp(c),
      });
      c.status(429);
      return c.json({
        error: "Too many login attempts. Please try again later.",
      });
    }

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

    if (user.status !== "ACTIVE") {
      logAuthEvent("login_failed", { userId: user.id, email: user.email, reason: "account_not_active" });
      c.status(403);
      return c.json({ error: "Account is not active. Please verify your email." });
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
      "UPDATE users SET failed_login_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?",
    )
      .bind(now, user.id)
      .run();

    const accessToken = await generateAccessToken(user.id, user.email, c.env.JWT_SECRET);
    const refreshToken = await generateRefreshToken(user.id, user.email, c.env.JWT_SECRET);
    const refreshExpiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;

    const refreshPayload = decodeJwtPayload(refreshToken);
    const refreshJti = (refreshPayload?.jti as string) || crypto.randomUUID();

    const activeCount = await countActiveRefreshTokens(c, user.id);
    if (activeCount >= MAX_ACTIVE_REFRESH_TOKENS) {
      const toRevoke = await c.env.DB.prepare(
        `SELECT jti FROM refresh_tokens
         WHERE user_id = ? AND revoked = 0 AND expires_at > ?
         ORDER BY created_at ASC LIMIT ?`,
      )
        .bind(user.id, Math.floor(Date.now() / 1000), activeCount - MAX_ACTIVE_REFRESH_TOKENS + 1)
        .all<{ jti: string }>();

      for (const row of toRevoke.results) {
        await revokeRefreshToken(c, row.jti);
      }
    }

    await storeRefreshToken(c, refreshJti, user.id, refreshExpiresAt);

    logAuthEvent("login_success", { userId: user.id, email: user.email });

    c.status(200);
    return c.json({
      accessToken,
      refreshToken,
    });
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
    await revokeAllUserRefreshTokens(c, userId);

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

/**
 * Generates a password reset token and stores it.
 */
export async function handleForgotPassword(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const { email } = await c.req.json<{ email?: string }>();
    const normalizedEmail = email ? normalizeEmail(email) : "";

    if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
      c.status(400);
      return c.json({ error: "A valid email is required." });
    }

    const user = await c.env.DB.prepare(
      "SELECT id, email FROM users WHERE email = ?",
    )
      .bind(normalizedEmail)
      .first<{ id: string; email: string }>();

    if (!user) {
      c.status(404);
      return c.json({ error: "No account found with that email address." });
    }

    const resetToken = crypto.randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;

    await c.env.DB.prepare(
      "INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)",
    )
      .bind(resetToken, user.id, expiresAt)
      .run();

    logAuthEvent("password_reset_requested", { userId: user.id, email: user.email });

    c.status(200);
    return c.json({
      message: "Password reset instructions have been sent to your email.",
      resetToken,
    });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Forgot password error:", error);
    c.status(500);
    return c.json({
      error: "An internal server error occurred.",
      message: error.message,
    });
  }
}

/**
 * Resets the user's password using a valid reset token.
 */
export async function handleResetPassword(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const { token, newPassword } = await c.req.json<{
      token?: string;
      newPassword?: string;
    }>();

    if (!token || !newPassword) {
      c.status(400);
      return c.json({ error: "Reset token and new password are required." });
    }

    if (!isValidPassword(newPassword)) {
      c.status(400);
      return c.json({
        error:
          "Password must be at least 8 characters with uppercase, lowercase, number, and special character.",
      });
    }

    const resetRecord = await c.env.DB.prepare(
      "SELECT user_id, expires_at FROM password_reset_tokens WHERE token = ?",
    )
      .bind(token)
      .first<{ user_id: string; expires_at: number }>();

    if (!resetRecord || resetRecord.expires_at < Date.now() / 1000) {
      c.status(400);
      return c.json({ error: "Invalid or expired reset token." });
    }

    const hashedPassword = await hashPassword(newPassword);
    const now = new Date().toISOString();

    await c.env.DB.prepare(
      "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
    )
      .bind(hashedPassword, now, resetRecord.user_id)
      .run();

    await c.env.DB.prepare(
      "DELETE FROM password_reset_tokens WHERE token = ?",
    )
      .bind(token)
      .run();

    logAuthEvent("password_reset_completed", { userId: resetRecord.user_id });

    c.status(200);
    return c.json({ message: "Password has been reset successfully." });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Reset password error:", error);
    c.status(500);
    return c.json({
      error: "An internal server error occurred.",
      message: error.message,
    });
  }
}

/**
 * Refreshes an access token using a valid refresh token.
 */
export async function handleRefresh(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const { refreshToken } = await c.req.json<{ refreshToken?: string }>();

    if (!refreshToken) {
      c.status(400);
      return c.json({ error: "Refresh token is required." });
    }

    const payload = await validateRefreshToken(c, refreshToken, c.env.JWT_SECRET);
    if (!payload) {
      c.status(401);
      return c.json({ error: "Invalid or expired refresh token." });
    }

    await revokeRefreshToken(c, payload.jti);

    const newAccessToken = await generateAccessToken(payload.sub, payload.email, c.env.JWT_SECRET);
    const newRefreshToken = await generateRefreshToken(payload.sub, payload.email, c.env.JWT_SECRET);
    const newRefreshExpiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;

    const newRefreshPayload = decodeJwtPayload(newRefreshToken);
    const newRefreshJti = (newRefreshPayload?.jti as string) || crypto.randomUUID();

    const activeCount = await countActiveRefreshTokens(c, payload.sub);
    if (activeCount >= MAX_ACTIVE_REFRESH_TOKENS) {
      const toRevoke = await c.env.DB.prepare(
        `SELECT jti FROM refresh_tokens
         WHERE user_id = ? AND revoked = 0 AND expires_at > ?
         ORDER BY created_at ASC LIMIT ?`,
      )
        .bind(payload.sub, Math.floor(Date.now() / 1000), activeCount - MAX_ACTIVE_REFRESH_TOKENS + 1)
        .all<{ jti: string }>();

      for (const row of toRevoke.results) {
        await revokeRefreshToken(c, row.jti);
      }
    }

    await storeRefreshToken(c, newRefreshJti, payload.sub, newRefreshExpiresAt);

    logAuthEvent("token_refreshed", { userId: payload.sub });

    c.status(200);
    return c.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Refresh error:", error);
    c.status(500);
    return c.json({
      error: "An internal server error occurred.",
      message: error.message,
    });
  }
}
