// src/handlers/user.ts
import { Context } from "hono";
import { Env } from "../index";
import { hashPassword, verifyPassword, generateJwt } from "./auth"; // Corrected path
import { sendOtpEmail } from "./email"; // Corrected path

/**
 * Handles the user registration request.
 * Creates a user in a 'PENDING_VERIFICATION' state and sends an OTP email.
 */
export async function handleRegister(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const { email, password } = await c.req.json<{
      email?: string;
      password?: string;
    }>();

    if (!email || !password || password.length < 8) {
      c.status(400);
      return c.json({
        error:
          "Invalid input. Email is required and password must be at least 8 characters.",
      });
    }

    const existingUser = await c.env.DB.prepare(
      "SELECT status FROM users WHERE email = ?",
    )
      .bind(email)
      .first<{ status: string }>();
    if (existingUser?.status === "ACTIVE") {
      c.status(409);
      return c.json({
        error: "An active user with this email already exists.",
      });
    }

    const hashedPassword = await hashPassword(password);
    const newUserId = crypto.randomUUID();
    const otp = crypto
      .getRandomValues(new Uint32Array(1))[0]
      .toString()
      .slice(0, 6)
      .padStart(6, "0");
    const otpExpiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    const emailResponse = await sendOtpEmail(c.env.RESEND_API_KEY, email, otp);
    if (!emailResponse.ok) {
      console.error(
        "Failed to send verification email:",
        await emailResponse.text(),
      );
      c.status(500);
      return c.json({ error: "Failed to send verification email." });
    }

    await c.env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, status, otp_secret, otp_expires_at)
       VALUES (?, ?, ?, 'PENDING_VERIFICATION', ?, ?)
       ON CONFLICT(email) DO UPDATE SET
       password_hash = excluded.password_hash, status = 'PENDING_VERIFICATION', otp_secret = excluded.otp_secret, otp_expires_at = excluded.otp_expires_at`,
    )
      .bind(newUserId, email, hashedPassword, otp, otpExpiresAt)
      .run();

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
    if (!email || !password) {
      c.status(400);
      return c.json({ error: "Email and password are required." });
    }

    const user = await c.env.DB.prepare(
      "SELECT id, email, password_hash, status FROM users WHERE email = ?",
    )
      .bind(email)
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
    if (!email || !otp) {
      c.status(400);
      return c.json({ error: "Email and OTP are required." });
    }

    const user = await c.env.DB.prepare(
      "SELECT id, otp_secret, otp_expires_at FROM users WHERE email = ? AND status = ?",
    )
      .bind(email, "PENDING_VERIFICATION")
      .first<{ id: string; otp_secret: string; otp_expires_at: number }>();

    if (!user) {
      c.status(404);
      return c.json({ error: "User not found or already verified." });
    }
    if (Date.now() > user.otp_expires_at) {
      c.status(410);
      return c.json({ error: "OTP has expired. Please request a new one." });
    }
    if (user.otp_secret !== otp) {
      c.status(400);
      return c.json({ error: "Invalid OTP." });
    }

    await c.env.DB.prepare(
      "UPDATE users SET status = ?, otp_secret = NULL, otp_expires_at = NULL WHERE id = ?",
    )
      .bind("ACTIVE", user.id)
      .run();

    const token = await generateJwt(user.id, email, c.env.JWT_SECRET);
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
