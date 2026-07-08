// src/utils/types.ts
export interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL?: string;
  AUTH_ALLOW_DEV_OTP_FALLBACK?: string;
  JWT_SECRET: string;
}
