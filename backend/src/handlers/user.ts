// src/handlers/user.ts
import { Env } from '../utils/types';
import { hashPassword, verifyPassword, generateJwt } from '../utils/auth';
import { sendOtpEmail } from '../services/email';

/**
 * Handles the user registration request.
 * Creates a user in a 'PENDING_VERIFICATION' state and sends an OTP email.
 */
export async function handleRegister(request: Request, env: Env): Promise<Response> {
  try {
    const { email, password } = await request.json<{ email?: string; password?: string }>();

    if (!email || !password || password.length < 8) {
      return new Response(JSON.stringify({ error: 'Invalid input. Email is required and password must be at least 8 characters.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const existingUser = await env.DB.prepare('SELECT status FROM users WHERE email = ?').bind(email).first<{ status: string }>();
    if (existingUser?.status === 'ACTIVE') {
      return new Response(JSON.stringify({ error: 'An active user with this email already exists.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }

    const hashedPassword = await hashPassword(password);
    const newUserId = crypto.randomUUID();
    const otp = crypto.getRandomValues(new Uint32Array(1))[0].toString().slice(0, 6).padStart(6, '0');
    const otpExpiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    const emailResponse = await sendOtpEmail(env.RESEND_API_KEY, email, otp);
    if (!emailResponse.ok) {
      console.error('Failed to send verification email:', await emailResponse.text());
      return new Response(JSON.stringify({ error: 'Failed to send verification email.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    await env.DB.prepare(
      `INSERT INTO users (id, email, hashed_password, status, otp_secret, otp_expires_at)
       VALUES (?, ?, ?, 'PENDING_VERIFICATION', ?, ?)
       ON CONFLICT(email) DO UPDATE SET
       hashed_password = excluded.hashed_password, status = 'PENDING_VERIFICATION', otp_secret = excluded.otp_secret, otp_expires_at = excluded.otp_expires_at`
    ).bind(newUserId, email, hashedPassword, otp, otpExpiresAt).run();

    return new Response(JSON.stringify({ message: 'Verification OTP sent to your email.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Registration error:', error);
    return new Response(JSON.stringify({ error: 'An internal server error occurred.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

/**
 * Handles the user login request.
 * Verifies credentials and returns a JWT on success.
 */
export async function handleLogin(request: Request, env: Env): Promise<Response> {
  try {
    const { email, password } = await request.json<{ email?: string; password?: string }>();
    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'Email and password are required.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const user = await env.DB.prepare('SELECT id, email, hashed_password, status FROM users WHERE email = ?')
      .bind(email)
      .first<{ id: string; email: string; hashed_password: string; status: string }>();

    if (!user || user.status !== 'ACTIVE') {
      return new Response(JSON.stringify({ error: 'Invalid credentials or user not active.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const isPasswordValid = await verifyPassword(password, user.hashed_password);
    if (!isPasswordValid) {
      return new Response(JSON.stringify({ error: 'Invalid credentials or user not active.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const token = await generateJwt(user.id, user.email, env.JWT_SECRET);
    return new Response(JSON.stringify({ token }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Login error:', error);
    return new Response(JSON.stringify({ error: 'An internal server error occurred.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

/**
 * Handles the OTP verification request.
 * Activates the user's account if the OTP is valid and not expired.
 */
export async function handleVerifyOtp(request: Request, env: Env): Promise<Response> {
  try {
    const { email, otp } = await request.json<{ email?: string; otp?: string }>();
    if (!email || !otp) {
      return new Response(JSON.stringify({ error: 'Email and OTP are required.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const user = await env.DB.prepare('SELECT id, otp_secret, otp_expires_at FROM users WHERE email = ? AND status = ?')
      .bind(email, 'PENDING_VERIFICATION')
      .first<{ id: string; otp_secret: string; otp_expires_at: number }>();

    if (!user) {
      return new Response(JSON.stringify({ error: 'User not found or already verified.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    if (Date.now() > user.otp_expires_at) {
      return new Response(JSON.stringify({ error: 'OTP has expired. Please request a new one.' }), { status: 410, headers: { 'Content-Type': 'application/json' } });
    }
    if (user.otp_secret !== otp) {
      return new Response(JSON.stringify({ error: 'Invalid OTP.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    await env.DB.prepare('UPDATE users SET status = ?, otp_secret = NULL, otp_expires_at = NULL WHERE id = ?').bind('ACTIVE', user.id).run();

    return new Response(JSON.stringify({ message: 'Account activated successfully!' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Verification error:', error);
    return new Response(JSON.stringify({ error: 'An internal server error occurred.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}