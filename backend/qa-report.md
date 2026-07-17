# Crypto Pulse — Backend QA Report

**Worker:** http://127.0.0.1:8787
**Generated:** 2026-07-17T00:36:57.827Z

**Total:** 17 | ✅ Passed: 13 | ❌ Failed: 0 | ⚠️ Skipped: 4

| # | Check | Severity | Status | Details |
|---|-------|----------|--------|---------|
| 1 | Backend health check (/health) | critical | PASS | status=ok |
| 2 | Cloudflare D1 database connectivity (/db-status) | critical | PASS | schema intact |
| 3 | Authentication — user registration | critical | PASS | JWT issued |
| 4 | Authentication — user login | critical | PASS | JWT issued |
| 5 | Protected route — /profile (JWT auth) | high | PASS | user=qa+1784248617255@cryptopulse.dev |
| 6 | Public API — /strategies returns real data | high | PASS | 5 strategies |
| 7 | Public endpoint inventory (response codes) | medium | PASS | verify-otp=410, invalid-register=400 |
| 8 | Exchange connectivity (optional test credentials) | high | SKIP | QA_EXCHANGE_* secrets not provided |
| 9 | Live market data — real prices | high | SKIP | requires exchange test credentials |
| 10 | No hardcoded / mock / dummy data in responses | critical | PASS | 8 responses scanned |
| 11 | User-friendly error handling — meaningful messages, no raw stack traces | high | PASS | login=401, register=400, contentType=415 |
| 12 | Watchlist CRUD — add and remove tokens | medium | PASS | CRUD operations successful |
| 13 | Price alerts — create alert | medium | PASS | alert id=5c4e4b31-4b86-43e8-a21a-765dceaabe91 |
| 14 | Technical analysis (requires connected exchange) | high | SKIP | requires exchange test credentials |
| 15 | Market ticker + klines (requires connected exchange) | high | SKIP | requires exchange test credentials |
| 16 | FCM token registration | medium | PASS | token registered |
| 17 | Exchange connection status | medium | PASS | connected=false |

> ✅ No blocking failures.