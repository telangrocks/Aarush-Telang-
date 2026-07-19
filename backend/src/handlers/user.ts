// src/handlers/user.ts
import { Context } from "hono";
import { Env } from "../index";
import {
  hashPassword,
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  revokeRefreshToken,
  validateRefreshToken,
  decodeJwtPayload,
  countActiveRefreshTokens,
  revokeAllUserRefreshTokens,
  createAuditLog,
  runTransaction,
  MIN_PASSWORD_LENGTH,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCKOUT_MINUTES,
  MAX_ACTIVE_REFRESH_TOKENS,
} from "./auth";
import { sendEmail, buildVerificationEmail } from "../services/email";

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

function logAuthEvent(c: Context<{ Bindings: Env }>, event: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...details }));
  createAuditLog(c, {
    userId: (details.userId as string) || (details.user_id as string) || undefined,
    action: event,
    ip: (details.ip as string) || getClientIp(c),
    userAgent: c.req.header("user-agent") || undefined,
    metadata: details,
  }).catch(() => {});
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
 *
 * Product decision: registration is instant. The account is created ACTIVE and
 * access + refresh tokens are returned immediately so the user can enter the app
 * right away (matching the mobile onboarding UX). Email verification is optional
 * and is offered via a best-effort verification email; it never blocks sign-up
 * or subsequent login.
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
      logAuthEvent(c, "registration_rate_limited", {
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
    const verificationToken = crypto.randomUUID();
    const verificationExpiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24;

    const userId = existingUser?.id ?? crypto.randomUUID();

    if (existingUser) {
      // Re-registering over a previously PENDING_VERIFICATION account: reset
      // credentials and activate it immediately.
      await runTransaction(c, [
        {
          sql: `UPDATE users
                SET password_hash = ?,
                    updated_at = ?,
                    status = 'ACTIVE',
                    email_verified_at = NULL,
                    verification_token = ?,
                    verification_token_expires_at = ?,
                    failed_login_attempts = 0,
                    locked_until = NULL
                WHERE id = ?`,
          bindings: [hashedPassword, now, verificationToken, verificationExpiresAt, userId],
        },
      ]);
    } else {
      await runTransaction(c, [
        {
          sql: `INSERT INTO users (id, email, password_hash, created_at, status, updated_at, failed_login_attempts, locked_until, verification_token, verification_token_expires_at)
                VALUES (?, ?, ?, ?, 'ACTIVE', ?, 0, NULL, ?, ?)`,
          bindings: [userId, normalizedEmail, hashedPassword, now, now, verificationToken, verificationExpiresAt],
        },
      ]);
    }

    // Issue tokens immediately so the client is authenticated right after signup.
    const accessToken = await generateAccessToken(userId, normalizedEmail, c.env.JWT_SECRET);
    const refreshToken = await generateRefreshToken(userId, normalizedEmail, c.env.JWT_SECRET);
    const refreshExpiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;

    const refreshPayload = decodeJwtPayload(refreshToken);
    const refreshJti = (refreshPayload?.jti as string) || crypto.randomUUID();

    await runTransaction(c, [
      {
        sql: "INSERT INTO refresh_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)",
        bindings: [refreshJti, userId, refreshExpiresAt],
      },
    ]);

    // Best-effort optional verification email. Never blocks registration.
    const baseUrl = c.req.url.replace(/\/api\/.*$/, "");
    const verificationLink = `${baseUrl}/api/verify-email?token=${verificationToken}`;
    try {
      const { subject, html } = buildVerificationEmail(verificationLink);
      await sendEmail(c.env, { to: normalizedEmail, subject, html });
    } catch (emailError) {
      console.error("Failed to send verification email:", emailError);
    }

    logAuthEvent(c, "user_registered", { userId, email: normalizedEmail });

    c.status(201);
    return c.json({
      message: "Account created successfully.",
      accessToken,
      refreshToken,
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
 * Resends an email verification link for a pending account.
 */
export async function handleResendVerification(
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
      "SELECT id, status FROM users WHERE email = ?",
    )
      .bind(normalizedEmail)
      .first<{ id: string; status: string }>();

    if (!user) {
      c.status(404);
      return c.json({ error: "No account found with that email address." });
    }

    if (user.status === "ACTIVE") {
      c.status(200);
      return c.json({ message: "Email is already verified." });
    }

    const verificationToken = crypto.randomUUID();
    const verificationExpiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24;

    await runTransaction(c, [
      {
        sql: "UPDATE users SET verification_token = ?, verification_token_expires_at = ? WHERE id = ?",
        bindings: [verificationToken, verificationExpiresAt, user.id],
      },
    ]);

    const baseUrl = c.req.url.replace(/\/api\/.*$/, "");
    const verificationLink = `${baseUrl}/api/verify-email?token=${verificationToken}`;

    try {
      const { subject, html } = buildVerificationEmail(verificationLink);
      await sendEmail(c.env, { to: normalizedEmail, subject, html });
    } catch (emailError) {
      console.error("Failed to send verification email:", emailError);
      c.status(500);
      return c.json({ error: "Failed to send verification email." });
    }

    logAuthEvent(c, "verification_email_resent", { userId: user.id, email: normalizedEmail });

    c.status(200);
    return c.json({ message: "Verification email sent." });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Resend verification error:", error);
    c.status(500);
    return c.json({
      error: "An internal server error occurred.",
      message: error.message,
    });
  }
}

/**
 * Verifies a user's email using the verification token.
 */
export async function handleVerifyEmail(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const token = c.req.query("token");
    if (!token) {
      c.status(400);
      return c.json({ error: "Verification token is required." });
    }

    const user = await c.env.DB.prepare(
      "SELECT id, email, status, verification_token_expires_at FROM users WHERE verification_token = ?",
    )
      .bind(token)
      .first<{
        id: string;
        email: string;
        status: string;
        verification_token_expires_at: number | null;
      }>();

    if (!user) {
      c.status(400);
      return c.json({ error: "Invalid verification token." });
    }

    if (user.status === "ACTIVE") {
      c.status(200);
      return c.json({ message: "Email is already verified." });
    }

    if (!user.verification_token_expires_at || user.verification_token_expires_at < Date.now() / 1000) {
      c.status(400);
      return c.json({ error: "Verification token has expired." });
    }

    const now = new Date().toISOString();
    await runTransaction(c, [
      {
        sql: "UPDATE users SET status = 'ACTIVE', email_verified_at = ?, verification_token = NULL, verification_token_expires_at = NULL WHERE id = ?",
        bindings: [now, user.id],
      },
    ]);

    logAuthEvent(c, "email_verified", { userId: user.id, email: user.email });

    c.status(200);
    return c.json({ message: "Email verified successfully." });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Verify email error:", error);
    c.status(500);
    return c.json({
      error: "An internal server error occurred.",
      message: error.message,
    });
  }
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
      logAuthEvent(c, "login_rate_limited", {
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
      logAuthEvent(c, "login_failed", { email: normalizedEmail, reason: "user_not_found" });
      c.status(401);
      return c.json({ error: "Invalid credentials." });
    }

    if (user.status !== "ACTIVE") {
      logAuthEvent(c, "login_failed", { userId: user.id, email: user.email, reason: "account_not_active" });
      c.status(403);
      return c.json({ error: "Account is not active. Please verify your email." });
    }

    if (user.locked_until && user.locked_until > Date.now()) {
      logAuthEvent(c, "login_failed", { userId: user.id, email: user.email, reason: "account_locked" });
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

      logAuthEvent(c, "login_failed", { userId: user.id, email: user.email, reason: "invalid_password", attempts: newAttempts });
      c.status(401);
      return c.json({ error: "Invalid credentials." });
    }

    const now = new Date().toISOString();
    await runTransaction(c, [
      {
        sql: "UPDATE users SET failed_login_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?",
        bindings: [now, user.id],
      },
    ]);

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

      const revokeStatements = toRevoke.results.map((row) => ({
        sql: "UPDATE refresh_tokens SET revoked = 1 WHERE jti = ?",
        bindings: [row.jti],
      }));

      if (revokeStatements.length > 0) {
        await runTransaction(c, revokeStatements);
      }
    }

    await runTransaction(c, [
      {
        sql: "INSERT INTO refresh_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)",
        bindings: [refreshJti, user.id, refreshExpiresAt],
      },
    ]);

    logAuthEvent(c, "login_success", { userId: user.id, email: user.email });

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

    await runTransaction(c, [
      {
        sql: "INSERT OR IGNORE INTO jwt_blacklist (jti, user_id, expires_at) VALUES (?, ?, ?)",
        bindings: [jti, userId, Date.now() / 1000 + 60 * 60 * 24 * 7],
      },
      {
        sql: "UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0",
        bindings: [userId],
      },
      {
        sql: "UPDATE users SET fcm_token = NULL WHERE id = ?",
        bindings: [userId],
      },
    ]);

    logAuthEvent(c, "user_logout", { userId });

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

    logAuthEvent(c, "password_reset_requested", { userId: user.id, email: user.email });

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

    logAuthEvent(c, "password_reset_completed", { userId: resetRecord.user_id });

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

      const revokeStatements = toRevoke.results.map((row) => ({
        sql: "UPDATE refresh_tokens SET revoked = 1 WHERE jti = ?",
        bindings: [row.jti],
      }));

      if (revokeStatements.length > 0) {
        await runTransaction(c, revokeStatements);
      }
    }

    await runTransaction(c, [
      {
        sql: "INSERT INTO refresh_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)",
        bindings: [newRefreshJti, payload.sub, newRefreshExpiresAt],
      },
    ]);

    logAuthEvent(c, "token_refreshed", { userId: payload.sub });

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

/**
 * Soft deletes the authenticated user's account.
 */
export async function handleDeleteAccount(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    if (!payload || !payload.sub) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const now = new Date().toISOString();
    await runTransaction(c, [
      {
        sql: "UPDATE users SET is_deleted = 1, deleted_at = ?, status = 'DELETED' WHERE id = ? AND is_deleted = 0",
        bindings: [now, payload.sub],
      },
    ]);

    await revokeAllUserRefreshTokens(c, payload.sub);

    logAuthEvent(c, "account_deleted", { userId: payload.sub });

    c.status(200);
    return c.json({ message: "Account deleted successfully." });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Delete account error:", error);
    c.status(500);
    return c.json({ error: "An internal server error occurred.", message: error.message });
  }
}

/**
 * Registers a device for the authenticated user.
 */
export async function handleRegisterDevice(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    if (!payload || !payload.sub) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const { deviceName, deviceType } = await c.req.json<{
      deviceName?: string;
      deviceType?: string;
    }>();

    if (!deviceName || !deviceType) {
      c.status(400);
      return c.json({ error: "Device name and type are required." });
    }

    const deviceId = crypto.randomUUID();
    const now = new Date().toISOString();

    await runTransaction(c, [
      {
        sql: "INSERT INTO user_devices (id, user_id, device_name, device_type, last_used_at) VALUES (?, ?, ?, ?, ?)",
        bindings: [deviceId, payload.sub, deviceName, deviceType, now],
      },
    ]);

    logAuthEvent(c, "device_registered", { userId: payload.sub, deviceId, deviceType });

    c.status(201);
    return c.json({ id: deviceId, deviceName, deviceType, createdAt: now });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Register device error:", error);
    c.status(500);
    return c.json({ error: "An internal server error occurred.", message: error.message });
  }
}

/**
 * Lists all devices for the authenticated user.
 */
export async function handleListDevices(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    if (!payload || !payload.sub) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const devices = await c.env.DB.prepare(
      "SELECT id, device_name, device_type, last_used_at, created_at FROM user_devices WHERE user_id = ?",
    )
      .bind(payload.sub)
      .all<{
        id: string;
        device_name: string;
        device_type: string;
        last_used_at: string;
        created_at: string;
      }>();

    c.status(200);
    return c.json({ devices: devices.results });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("List devices error:", error);
    c.status(500);
    return c.json({ error: "An internal server error occurred.", message: error.message });
  }
}

/**
 * Removes a device for the authenticated user.
 */
export async function handleRemoveDevice(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    if (!payload || !payload.sub) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const deviceId = c.req.param("id");
    if (!deviceId) {
      c.status(400);
      return c.json({ error: "Device ID is required." });
    }

    await runTransaction(c, [
      {
        sql: "DELETE FROM user_devices WHERE id = ? AND user_id = ?",
        bindings: [deviceId, payload.sub],
      },
    ]);

    logAuthEvent(c, "device_removed", { userId: payload.sub, deviceId });

    c.status(200);
    return c.json({ message: "Device removed successfully." });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Remove device error:", error);
    c.status(500);
    return c.json({ error: "An internal server error occurred.", message: error.message });
  }
}

/**
 * Enables MFA for the authenticated user.
 */
export async function handleEnableMfa(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    if (!payload || !payload.sub) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const secret = crypto.randomUUID().replace(/-/g, "").substring(0, 32);
    const now = new Date().toISOString();

    await runTransaction(c, [
      {
        sql: `INSERT INTO user_security_settings (user_id, mfa_enabled, mfa_secret, created_at, updated_at)
              VALUES (?, 1, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET
                mfa_enabled = 1,
                mfa_secret = excluded.mfa_secret,
                updated_at = excluded.updated_at`,
        bindings: [payload.sub, secret, now, now],
      },
    ]);

    logAuthEvent(c, "mfa_enabled", { userId: payload.sub });

    c.status(200);
    return c.json({ message: "MFA enabled successfully.", secret });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Enable MFA error:", error);
    c.status(500);
    return c.json({ error: "An internal server error occurred.", message: error.message });
  }
}

/**
 * Disables MFA for the authenticated user.
 */
export async function handleDisableMfa(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    if (!payload || !payload.sub) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const now = new Date().toISOString();

    await runTransaction(c, [
      {
        sql: `UPDATE user_security_settings
              SET mfa_enabled = 0, mfa_secret = NULL, updated_at = ?
              WHERE user_id = ?`,
        bindings: [now, payload.sub],
      },
    ]);

    logAuthEvent(c, "mfa_disabled", { userId: payload.sub });

    c.status(200);
    return c.json({ message: "MFA disabled successfully." });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Disable MFA error:", error);
    c.status(500);
    return c.json({ error: "An internal server error occurred.", message: error.message });
  }
}

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MINUTES = 15;

/**
 * Sets a new PIN for the authenticated user.
 */
export async function handleSetPin(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    if (!payload || !payload.sub) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const { pin } = await c.req.json<{ pin?: string }>();
    if (!pin || pin.length < 4 || pin.length > 8) {
      c.status(400);
      return c.json({ error: "PIN must be between 4 and 8 digits." });
    }

    const pinHash = await hashPassword(pin);

    await runTransaction(c, [
      {
        sql: "UPDATE users SET pin_hash = ?, pin_attempts = 0, pin_locked_until = NULL WHERE id = ?",
        bindings: [pinHash, payload.sub],
      },
    ]);

    logAuthEvent(c, "pin_set", { userId: payload.sub });

    c.status(200);
    return c.json({ message: "PIN set successfully." });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Set PIN error:", error);
    c.status(500);
    return c.json({ error: "An internal server error occurred.", message: error.message });
  }
}

/**
 * Verifies a user's PIN for quick authentication.
 */
export async function handleVerifyPin(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const { email, pin } = await c.req.json<{ email?: string; pin?: string }>();
    const normalizedEmail = email ? normalizeEmail(email) : "";

    if (!normalizedEmail || !isValidEmail(normalizedEmail) || !pin) {
      c.status(400);
      return c.json({ error: "Email and PIN are required." });
    }

    const user = await c.env.DB.prepare(
      "SELECT id, pin_hash, pin_attempts, pin_locked_until FROM users WHERE email = ? AND is_deleted = 0",
    )
      .bind(normalizedEmail)
      .first<{ id: string; pin_hash: string; pin_attempts: number; pin_locked_until: string | null }>();

    if (!user || !user.pin_hash) {
      c.status(401);
      return c.json({ error: "Invalid email or PIN." });
    }

    if (user.pin_locked_until && new Date(user.pin_locked_until) > new Date()) {
      c.status(423);
      return c.json({ error: "Too many PIN attempts. Try again later." });
    }

    const pinValid = await verifyPassword(pin, user.pin_hash);
    if (!pinValid) {
      const newAttempts = user.pin_attempts + 1;
      const lockedUntil = newAttempts >= MAX_PIN_ATTEMPTS
        ? new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60 * 1000).toISOString()
        : null;

      await c.env.DB.prepare(
        "UPDATE users SET pin_attempts = ?, pin_locked_until = ? WHERE id = ?",
      )
        .bind(newAttempts, lockedUntil, user.id)
        .run();

      logAuthEvent(c, "pin_verification_failed", { userId: user.id, attempts: newAttempts });
      c.status(401);
      return c.json({ error: "Invalid email or PIN." });
    }

    await c.env.DB.prepare(
      "UPDATE users SET pin_attempts = 0, pin_locked_until = NULL WHERE id = ?",
    )
      .bind(user.id)
      .run();

    logAuthEvent(c, "pin_verified", { userId: user.id });

    c.status(200);
    return c.json({ success: true, user_id: user.id });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Verify PIN error:", error);
    c.status(500);
    return c.json({ error: "An internal server error occurred.", message: error.message });
  }
}

/**
 * Requests a PIN reset via email.
 */
export async function handleRequestPinReset(
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
      "SELECT id FROM users WHERE email = ? AND is_deleted = 0",
    )
      .bind(normalizedEmail)
      .first<{ id: string }>();

    if (!user) {
      c.status(404);
      return c.json({ error: "No account found with that email address." });
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 24 * 1000).toISOString();

    await c.env.DB.prepare(
      "INSERT INTO pin_reset_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), user.id, token, expiresAt)
      .run();

    const baseUrl = c.req.url.replace(/\/api\/.*$/, "");
    const resetLink = `${baseUrl}/api/reset-pin?token=${token}`;

    try {
      const { subject, html } = buildVerificationEmail(resetLink);
      await sendEmail(c.env, { to: normalizedEmail, subject, html });
    } catch (emailError) {
      console.error("Failed to send PIN reset email:", emailError);
      c.status(500);
      return c.json({ error: "Failed to send PIN reset email." });
    }

    logAuthEvent(c, "pin_reset_requested", { userId: user.id, email: normalizedEmail });

    c.status(200);
    return c.json({ message: "PIN reset email sent." });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Request PIN reset error:", error);
    c.status(500);
    return c.json({ error: "An internal server error occurred.", message: error.message });
  }
}

/**
 * Confirms a PIN reset with the token from email.
 */
export async function handleConfirmPinReset(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const token = c.req.query("token");
    if (!token) {
      c.status(400);
      return c.json({ error: "Reset token is required." });
    }

    const resetRecord = await c.env.DB.prepare(
      "SELECT id, user_id, expires_at, used FROM pin_reset_tokens WHERE token = ?",
    )
      .bind(token)
      .first<{ id: string; user_id: string; expires_at: string; used: number }>();

    if (!resetRecord || resetRecord.used === 1) {
      c.status(400);
      return c.json({ error: "Invalid or expired reset token." });
    }

    if (new Date(resetRecord.expires_at) < new Date()) {
      c.status(400);
      return c.json({ error: "Reset token has expired." });
    }

    const { pin } = await c.req.json<{ pin?: string }>();
    if (!pin || pin.length < 4 || pin.length > 8) {
      c.status(400);
      return c.json({ error: "PIN must be between 4 and 8 digits." });
    }

    const pinHash = await hashPassword(pin);

    await runTransaction(c, [
      {
        sql: "UPDATE users SET pin_hash = ?, pin_attempts = 0, pin_locked_until = NULL WHERE id = ?",
        bindings: [pinHash, resetRecord.user_id],
      },
      {
        sql: "UPDATE pin_reset_tokens SET used = 1 WHERE id = ?",
        bindings: [resetRecord.id],
      },
    ]);

    logAuthEvent(c, "pin_reset_completed", { userId: resetRecord.user_id });

    c.status(200);
    return c.json({ message: "PIN reset successfully." });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Confirm PIN reset error:", error);
    c.status(500);
    return c.json({ error: "An internal server error occurred.", message: error.message });
  }
}
