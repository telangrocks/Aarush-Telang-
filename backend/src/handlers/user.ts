// src/handlers/user.ts
import { Context } from "hono";
import { Env } from "../index";
import { hashPassword, verifyPassword, generateJwt } from "./auth";
import { sendOtpEmail } from "./email";

const OTP_EXPIRY_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_REGEX = /^\d{6}$/;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

function isDevOtpFallbackEnabled(env: Env): boolean {
  return env.AUTH_ALLOW_DEV_OTP_FALLBACK === "true";
}

function generateOtp(): string {
  const otpRange = 1_000_000;
  const maxUint32 = 0x1_0000_0000;
  const limit = Math.floor(maxUint32 / otpRange) * otpRange;

  let randomNumber: number;
  do {
    randomNumber = crypto.getRandomValues(new Uint32Array(1))[0]!;
  } while (randomNumber >= limit);

  return (randomNumber % otpRange).toString().padStart(6, "0");
}

async function sendVerificationOtp(
  c: Context<{ Bindings: Env }>,
  email: string,
  otp: string,
): Promise<Response> {
  const emailResponse = await sendOtpEmail(
    c.env.RESEND_API_KEY,
    c.env.RESEND_FROM_EMAIL,
    email,
    otp,
  );

  if (!emailResponse.ok) {
    throw new Error(await emailResponse.text());
  }

  return emailResponse;
}

function handleEmailDeliveryFailure(
  c: Context<{ Bindings: Env }>,
  otp: string,
  error: unknown,
): Response {
  const emailFailureMessage =
    error instanceof Error ? error.message : "Unknown email delivery error";

  console.error("Failed to send verification email:", emailFailureMessage);

  if (isDevOtpFallbackEnabled(c.env)) {
    c.status(200);
    return c.json({
      message: "Verification OTP generated for testing.",
      otp,
      emailDeliveryFailed: true,
    });
  }

  c.status(502);
  return c.json({
    error: "Unable to send verification email. Please try again later.",
  });
}

/**
 * Handles the user registration request.
 * Creates or refreshes a user in a 'PENDING_VERIFICATION' state and sends an OTP email.
 */
export async function handleRegister(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const { email, password } = await c.req.json<{
      email?: string;
      password?: string;
    }>();

    const normalizedEmail = email ? normalizeEmail(email) : "";
    if (
      !normalizedEmail ||
      !isValidEmail(normalizedEmail) ||
      !password ||
      password.length < 8
    ) {
      c.status(400);
      return c.json({
        error:
          "Invalid input. A valid email is required and password must be at least 8 characters.",
      });
    }

    const now = Date.now();
    const existingUser = await c.env.DB.prepare(
      "SELECT status, otp_last_sent_at FROM users WHERE email = ?",
    )
      .bind(normalizedEmail)
      .first<{ status: string; otp_last_sent_at: number | null }>();

    if (existingUser?.status === "ACTIVE") {
      c.status(409);
      return c.json({
        error: "An active user with this email already exists.",
      });
    }

    if (
      existingUser?.status === "PENDING_VERIFICATION" &&
      existingUser.otp_last_sent_at &&
      now - existingUser.otp_last_sent_at < OTP_RESEND_COOLDOWN_MS
    ) {
      c.status(429);
      return c.json({
        error: "Please wait before requesting another verification code.",
      });
    }

    const hashedPassword = await hashPassword(password);
    const otp = generateOtp();
    const otpHash = await hashPassword(otp);
    const otpExpiresAt = now + OTP_EXPIRY_MS;
    const createdAt = new Date(now).toISOString();

    await c.env.DB.prepare(
      `INSERT INTO users (
         id,
         email,
         password_hash,
         created_at,
         status,
         otp_secret,
         otp_expires_at,
         otp_last_sent_at,
         otp_attempt_count
       )
       VALUES (?, ?, ?, ?, 'PENDING_VERIFICATION', ?, ?, ?, 0)
       ON CONFLICT(email) DO UPDATE SET
         password_hash = excluded.password_hash,
         status = 'PENDING_VERIFICATION',
         otp_secret = excluded.otp_secret,
         otp_expires_at = excluded.otp_expires_at,
         otp_last_sent_at = excluded.otp_last_sent_at,
         otp_attempt_count = 0`,
    )
      .bind(
        crypto.randomUUID(),
        normalizedEmail,
        hashedPassword,
        createdAt,
        otpHash,
        otpExpiresAt,
        now,
      )
      .run();

    try {
      await sendVerificationOtp(c, normalizedEmail, otp);
    } catch (emailError: unknown) {
      return handleEmailDeliveryFailure(c, otp, emailError);
    }

    c.status(200);
    return c.json({ message: "Verification OTP sent to your email." });
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
 * Resends a verification OTP for users that are still pending verification.
 */
export async function handleResendOtp(
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
      "SELECT id, status, otp_last_sent_at FROM users WHERE email = ?",
    )
      .bind(normalizedEmail)
      .first<{ id: string; status: string; otp_last_sent_at: number | null }>();

    if (!user || user.status !== "PENDING_VERIFICATION") {
      c.status(200);
      return c.json({
        message:
          "If an account requires verification, a new code has been sent.",
      });
    }

    const now = Date.now();
    if (
      user.otp_last_sent_at &&
      now - user.otp_last_sent_at < OTP_RESEND_COOLDOWN_MS
    ) {
      c.status(429);
      return c.json({
        error: "Please wait before requesting another verification code.",
      });
    }

    const otp = generateOtp();
    const otpHash = await hashPassword(otp);
    const otpExpiresAt = now + OTP_EXPIRY_MS;

    await c.env.DB.prepare(
      "UPDATE users SET otp_secret = ?, otp_expires_at = ?, otp_last_sent_at = ?, otp_attempt_count = 0 WHERE id = ?",
    )
      .bind(otpHash, otpExpiresAt, now, user.id)
      .run();

    try {
      await sendVerificationOtp(c, normalizedEmail, otp);
    } catch (emailError: unknown) {
      return handleEmailDeliveryFailure(c, otp, emailError);
    }

    c.status(200);
    return c.json({
      message: "If an account requires verification, a new code has been sent.",
    });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Resend OTP error:", error);
    c.status(500);
    return c.json({
      error: "An internal server error occurred.",
      message: error.message,
    });
  }
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
      "SELECT id, email, password_hash, status FROM users WHERE email = ?",
    )
      .bind(normalizedEmail)
      .first<{
        id: string;
        email: string;
        password_hash: string;
        status: string;
      }>();

    if (!user || user.status !== "ACTIVE") {
      c.status(401);
      return c.json({ error: "Invalid credentials or user not active." });
    }

    const isPasswordValid = await verifyPassword(password, user.password_hash);
    if (!isPasswordValid) {
      c.status(401);
      return c.json({ error: "Invalid credentials or user not active." });
    }

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
 * Handles the OTP verification request.
 * Activates the user's account if the OTP is valid and not expired.
 */
export async function handleVerifyOtp(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const { email, otp } = await c.req.json<{ email?: string; otp?: string }>();
    const normalizedEmail = email ? normalizeEmail(email) : "";
    const normalizedOtp = otp?.trim() ?? "";
    if (!normalizedEmail || !normalizedOtp || !OTP_REGEX.test(normalizedOtp)) {
      c.status(400);
      return c.json({ error: "Email and a valid 6-digit OTP are required." });
    }

    const user = await c.env.DB.prepare(
      "SELECT id, otp_secret, otp_expires_at, otp_attempt_count FROM users WHERE email = ? AND status = ?",
    )
      .bind(normalizedEmail, "PENDING_VERIFICATION")
      .first<{
        id: string;
        otp_secret: string | null;
        otp_expires_at: number | null;
        otp_attempt_count: number | null;
      }>();

    if (!user) {
      c.status(404);
      return c.json({ error: "User not found or already verified." });
    }

    if (!user.otp_expires_at || Date.now() > user.otp_expires_at) {
      c.status(410);
      return c.json({ error: "OTP has expired. Please request a new one." });
    }

    const currentAttemptCount = user.otp_attempt_count ?? 0;
    if (currentAttemptCount >= MAX_OTP_ATTEMPTS) {
      c.status(429);
      return c.json({
        error: "Too many invalid OTP attempts. Please request a new one.",
      });
    }

    const isOtpValid =
      !!user.otp_secret &&
      (await verifyPassword(normalizedOtp, user.otp_secret));
    if (!isOtpValid) {
      const nextAttemptCount = currentAttemptCount + 1;
      await c.env.DB.prepare(
        "UPDATE users SET otp_attempt_count = ? WHERE id = ?",
      )
        .bind(nextAttemptCount, user.id)
        .run();

      if (nextAttemptCount >= MAX_OTP_ATTEMPTS) {
        c.status(429);
        return c.json({
          error: "Too many invalid OTP attempts. Please request a new one.",
        });
      }

      c.status(400);
      return c.json({ error: "Invalid OTP." });
    }

    await c.env.DB.prepare(
      "UPDATE users SET status = ?, otp_secret = NULL, otp_expires_at = NULL, otp_last_sent_at = NULL, otp_attempt_count = 0 WHERE id = ?",
    )
      .bind("ACTIVE", user.id)
      .run();

    const token = await generateJwt(user.id, normalizedEmail, c.env.JWT_SECRET);
    c.status(200);
    return c.json({ message: "Account activated successfully!", token });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Verification error:", error);
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
