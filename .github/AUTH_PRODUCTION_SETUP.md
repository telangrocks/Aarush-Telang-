# Authentication setup

The app currently uses a simple production-friendly email and password flow.

## Current model

- users register with email + password
- accounts become active immediately
- login returns a JWT
- protected routes require that JWT

This keeps the app usable without a paid domain or transactional email provider.

## Current required Cloudflare Worker secrets/variables

Set these on the `crypto-pulse-backend` Worker:

- `JWT_SECRET`

Optional for future email verification work:

- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `AUTH_ALLOW_DEV_OTP_FALLBACK`

## Future hardening path

When you are ready to add paid email infrastructure later, you can reintroduce:

- email verification
- password reset by email
- optional MFA / OTP for sensitive actions
