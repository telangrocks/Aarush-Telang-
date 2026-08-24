# CryptoPulse — D1 Exchange Credential Persistence Forensic Investigation Report

**Investigation Date:** August 24, 2026  
**Investigator:** DeepMind AI Forensic Assistant (Antigravity)  
**Investigation Mode:** Evidence-Only Forensic Investigation (Zero Code Modifications)  
**Deliverable File:** `CryptoPulse_D1_Credential_Persistence_Forensic_Report.md`  

---

## A. Connection Endpoint Trace

The credential persistence chain is implemented across the following source components:

```text
[Android UI] ConnectExchangeScreen.kt:340
       ↓ User submits API Key, Secret, Environment (e.g. "demo")
[ViewModel] ExchangeViewModel.kt:356
       ↓ exchangeRepository.connectExchange(exchangeName, apiKey, apiSecret, passphrase, environment)
[Repository] ExchangeRepository.kt:28
       ↓ Maps to ConnectExchangeRequestDto
[Remote DataSource] ExchangeRemoteDataSource.kt:24
       ↓ Retrofit executes POST /api/exchange/connect
[Cloudflare Router] backend/src/index.ts:319
       ↓ api.post("/exchange/connect", handleConnectExchange)
[JWT Auth Middleware] backend/src/index.ts:251-274
       ↓ Validates HS256 JWT, extracts payload.sub as userId
[Backend Handler] backend/src/handlers/exchange.ts:236-370
       ├── Line 254-256: cleanCredential(apiKey), cleanCredential(apiSecret)
       ├── Line 268-289: normalizeEnvironment(environment), normalizeRegion(region)
       ├── Line 292-300: ExchangeManager.getProvider(...) -> provider.fetchBalance() (Validation)
       │    └── IF FAILS: Catches error -> returns HTTP 400 (D1 UPDATE IS SKIPPED)
       ├── Line 323-334: encrypt(cleanApiKey, c.env.ENCRYPTION_KEY), encrypt(cleanApiSecret, c.env.ENCRYPTION_KEY)
       ├── Line 337-355: D1 SQL UPDATE users SET exchange_* WHERE id = userId
       └── Line 368: Returns HTTP 200 { success: true, message: "Exchange connected successfully", ... }
```

---

## B. User ID Correlation

* **Connect Exchange User ID Source:** [`backend/src/handlers/exchange.ts:241-242`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L241-L242):
  ```typescript
  const payload = c.get("jwtPayload") as { sub: string };
  const userId = payload.sub;
  ```
* **Technical Analysis User ID Source:** [`backend/src/handlers/exchange.ts:958-959`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L958-L959):
  ```typescript
  const payload = c.get("jwtPayload") as { sub: string };
  const userId = payload.sub;
  ```
* **Correlation Verdict:** **MATCH**. Both handlers extract `userId` identically from the JWT `sub` claim.
* **Failure Condition:** If a client session registers a new account, logs out, or switches authentication tokens without re-running Connect Exchange for the new `userId`, the new user row in D1 has `exchange_api_key_encrypted = NULL`, while the previous user row retains the keys.

---

## C. D1 Schema & Column Persistence Evidence

The deployed production D1 database schema in `crypto_pulse_db` ([`backend/migrations/0027_encrypt_user_api_keys.sql`](file:///c:/CryptoPulse%20New/backend/migrations/0027_encrypt_user_api_keys.sql)) was inspected via live SQL queries:

| Column Name | Schema Type | Connect SQL Write Line | TA SQL Read Line | State (When Connected) | State (Unconnected / Failed Validation) |
|---|---|---|---|---|---|
| `exchange_name` | `TEXT` | [`exchange.ts:338`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L338) | [`exchange.ts:973`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L973) | **PRESENT** (`"bybit"`) | **NULL** |
| `exchange_environment` | `TEXT` | [`exchange.ts:338`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L338) | [`exchange.ts:973`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L973) | **PRESENT** (`"demo"`) | **NULL** / `"mainnet"` |
| `exchange_region` | `TEXT` | [`exchange.ts:338`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L338) | [`exchange.ts:973`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L973) | **PRESENT** | **NULL** |
| `exchange_api_key` | `TEXT` | Set to `NULL` (Line 338) | Not read | **NULL** (Plaintext purged) | **NULL** |
| `exchange_api_key_iv` | `TEXT` | [`exchange.ts:344`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L344) | [`exchange.ts:973`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L973) | **PRESENT** (16 chars base64) | **NULL** |
| `exchange_api_key_encrypted` | `TEXT` | [`exchange.ts:345`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L345) | [`exchange.ts:973`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L973) | **PRESENT** (44 chars base64) | **NULL** |
| `exchange_api_key_salt` | `TEXT` | [`exchange.ts:346`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L346) | [`exchange.ts:973`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L973) | **PRESENT** (24 chars base64) | **NULL** |
| `exchange_api_secret_iv` | `TEXT` | [`exchange.ts:347`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L347) | [`exchange.ts:973`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L973) | **PRESENT** (16 chars base64) | **NULL** |
| `exchange_api_secret_encrypted`| `TEXT` | [`exchange.ts:348`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L348) | [`exchange.ts:973`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L973) | **PRESENT** (68 chars base64) | **NULL** |
| `exchange_api_secret_salt` | `TEXT` | [`exchange.ts:349`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L349) | [`exchange.ts:973`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L973) | **PRESENT** (24 chars base64) | **NULL** |

---

## D. Database Binding Evidence

* **Wrangler Configuration:** [`backend/wrangler.toml:25-29`](file:///c:/CryptoPulse%20New/backend/wrangler.toml#L25-L29):
  ```toml
  [[d1_databases]]
  binding = "DB"
  database_name = "crypto_pulse_db"
  database_id = "15f49e2f-08bf-4dc5-8ec5-0860429fc0c4"
  preview_database_id = "15f49e2f-08bf-4dc5-8ec5-0860429fc0c4"
  ```
* **Handler Bindings:** Both `handleConnectExchange` and `handleGetTechnicalAnalysis` operate on `c.env.DB`, accessing database `15f49e2f-08bf-4dc5-8ec5-0860429fc0c4`.
* **Binding Verdict:** **MATCH**. There is no database binding divergence between endpoints.

---

## E. Environment Lineage Evidence

* **Connect Exchange Input:** `"demo"` $\rightarrow$ normalized to canonical `"demo"`.
* **Database Persisted Value:** `users.exchange_environment = "demo"`.
* **Technical Analysis Read:** `user.exchange_environment = "demo"` $\rightarrow$ passed to `normalizeEnvironment()` $\rightarrow$ resolves to Bybit Demo REST endpoint `https://api-demo.bybit.com`.
* **Environment Verdict:** **MATCH**.

---

## F. Live Controlled Reproduction Evidence

### Step 1: Exchange Connection Attempt with Invalid / Dummy Credentials
* **Request:** `POST https://crypto-pulse-backend.telangrocks.workers.dev/api/exchange/connect`
* **Ray ID:** `cf-ray: a2ffc90bc9cbff70-BOM`
* **Response Status:** `HTTP 400 Bad Request`
* **Response Body:**
  ```json
  {
    "success": false,
    "code": "AUTHENTICATION_FAILED",
    "message": "We couldn't authenticate with the exchange using these credentials.",
    "hint": "Authentication failed. Please verify that your API key is for the 'demo' environment.",
    "detail": "exchange=bybit exception=We couldn't authenticate with the exchange using these credentials.",
    "exchangeCode": 401,
    "httpStatus": 401
  }
  ```
* **Database State Check Immediately After:**
  - `exchange_name`: `NULL`
  - `exchange_api_key_encrypted`: `NULL`
  - `exchange_api_secret_encrypted`: `NULL`
* **Subsequent Technical Analysis Request:**
  - `POST /api/market/technical-analysis`
  - **Status:** `HTTP 400 Bad Request`
  - **Body:** `{"error":"No exchange connected. Please connect an exchange first."}` (68 bytes).

---

## G. Root Cause Classification

### **PROVEN: Conditional Persistence Gate combined with Pre-Validation Requirement**

1. **The Validation Gate:** [`handleConnectExchange`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L292-L321) requires a live, successful `provider.fetchBalance()` with Bybit before writing any credentials to D1.
2. **The Unwritten State:** If the user attempts to connect with unauthenticated / mock / invalid keys, or if the user creates a new account on Android without completing a successful Bybit authentication handshake, the backend halts at Line 305 and **never executes the D1 `UPDATE users` statement**.
3. **The Subsequent TA Rejection:** When the user subsequently enters `TechnicalAnalysisScreen`, `handleGetTechnicalAnalysis` queries D1, detects `exchange_api_key_encrypted = NULL`, and returns **HTTP 400** via Branch 2 (`"No exchange connected. Please connect an exchange first."`).

---

## H. Secondary Defect: Missing Credential Decryption in TA Handler

### **SOURCE-PROVEN SECONDARY DEFECT**

Even when an account has successfully connected to Bybit and contains valid encrypted keys in D1 (e.g. user `2d6067be-6ba1-44e0-ba3c-992a81dd2832`), `handleGetTechnicalAnalysis` contains a structural defect:
* **Source Location:** [`backend/src/handlers/exchange.ts:994-998`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L994-L998)
* **The Defect:**
  ```typescript
  const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
    environment: normalizeEnvironment(user.exchange_environment) ?? "mainnet",
    region: resolveCanonicalRoutingRegion(user.exchange_region),
    ...resolveEgressConfig(user.exchange_name, c.env),
  });
  ```
  `handleGetTechnicalAnalysis` queries the encrypted keys but **never calls `decrypt()`**, passing `apiKey: undefined` and `secret: undefined` to `ExchangeManager.getProvider`.
* **Runtime Impact:**
  - `fetchTicker()` (public) succeeds.
  - `fetchBalance()` (private) throws `MISSING_REQUIRED_CREDENTIALS`, which is swallowed by `.catch(() => null)` at Line 1025, defaulting `accountBalance = 1000`.
  - Preview analysis proceeds with an unauthenticated provider rather than the user's live Bybit wallet.

---

## I. Final Architecture Gap & State Divergence

```text
                                  ┌─────────────────────────────────────────────────────────┐
                                  │             Connect Exchange Screen                      │
                                  │      POST /api/exchange/connect                         │
                                  └──────────────────────────┬──────────────────────────────┘
                                                             │
                                             Live Bybit fetchBalance() check?
                                            /                                \
                                      [SUCCESS]                            [FAILURE]
                                         │                                     │
                          UPDATE D1 users table:                     DO NOT WRITE TO D1:
                          - exchange_name = "bybit"                  - exchange_name = NULL
                          - exchange_api_key_encrypted = "..."       - exchange_api_key_encrypted = NULL
                          - exchange_api_secret_encrypted = "..."    - exchange_api_secret_encrypted = NULL
                                         │                                     │
                                         ▼                                     ▼
                     ┌──────────────────────────────────────┐  ┌──────────────────────────────────────┐
                     │ Technical Analysis Request           │  │ Technical Analysis Request           │
                     │ POST /api/market/technical-analysis  │  │ POST /api/market/technical-analysis  │
                     └──────────────────┬───────────────────┘  └──────────────────┬───────────────────┘
                                        │                                         │
                                        ▼                                         ▼
                           hasApiKey check = TRUE                    hasApiKey check = FALSE
                                        │                                         │
                         Line 994: Provider created                  Line 990: Branch 2 Triggered
                         WITHOUT calling decrypt()                   Returns HTTP 400:
                         (Secondary Defect TA-1)                     "No exchange connected.
                                        │                             Please connect an exchange first."
                                        ▼
                         accountBalance defaults to 1000
```

---

## J. Implementation Readiness

### **READY FOR FIX**

All forensic boundaries, database schemas, encryption mechanisms, and handler lifecycles are completely verified:
1. **Primary Defect (Client Guidance / Connection State):** When exchange connection fails or credentials are missing in D1, the client must be guided to connect a valid exchange, and `TechnicalAnalysisViewModel` must handle `NetworkResult.Error` rather than silently dropping it.
2. **Secondary Defect TA-1:** [`backend/src/handlers/exchange.ts:972-998`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L972-L998) must invoke `decrypt()` on encrypted D1 keys and pass `apiKey` and `secret` to `ExchangeManager.getProvider`, mirroring the working Durable Object implementation in [`trading-bot.ts:1991-2015`](file:///c:/CryptoPulse%20New/backend/src/trading-bot.ts#L1991-L2015).
3. **Catch Block Hygiene TA-2:** [`backend/src/handlers/exchange.ts:1079`](file:///c:/CryptoPulse%20New/backend/src/handlers/exchange.ts#L1079) catch-block keyword filter must not coerce arbitrary internal errors into HTTP 400.
