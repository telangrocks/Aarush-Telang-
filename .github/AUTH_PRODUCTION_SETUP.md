# Production auth setup

The authentication flow now supports production-safe OTP verification.

## Required Cloudflare Worker secrets/variables

Set these on the `crypto-pulse-backend` Worker:

- `JWT_SECRET`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`

Optional development-only flag:

- `AUTH_ALLOW_DEV_OTP_FALLBACK=true`

Do not enable `AUTH_ALLOW_DEV_OTP_FALLBACK` in production.

## `RESEND_FROM_EMAIL` format

Use a verified sender, for example:

`CryptoPulse <auth@yourdomain.com>`

Do not leave placeholder values such as `onboarding@yourdomain.com`.

## Operational notes

- Registration now stores a hashed OTP instead of a raw OTP.
- OTP resend is available via `POST /api/resend-otp`.
- OTP verification is rate-limited by resend cooldown and attempt count.
- Apply D1 migrations before deploying backend code so `otp_last_sent_at` and `otp_attempt_count` exist.
