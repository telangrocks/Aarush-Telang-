# CryptoPulse — Android Client Telemetry & Observability Specification

**Document Version:** 1.0.0  
**Target Release:** Mobile Client v2.1.0  
**Backend Ingestion Endpoint:** `POST /api/client/telemetry` (Authenticated via User Bearer Token)  
**Classification:** Internal Engineering Specification

---

## 1. Executive Summary & Existing App Observability

### 1.1 Existing Android Client Status (Current Production APK: v2.0.0)
Based on our technical audit of `mobile/app/build.gradle.kts`, `AppModule.kt`, and `BackgroundMonitoringService.kt`:
- **Current App Binary:**
  - Zero third-party crash reporters (no Firebase Crashlytics, Sentry, or Bugsnag).
  - Empty `CryptoPulseApp.onCreate()`; no default `UncaughtExceptionHandler` registered.
  - OkHttp sends standard Android User-Agent without structured telemetry headers.
- **What is ALREADY Observable Today (Passive Edge Monitoring):**
  1. API request volume, route hit counts, and HTTP error rates (400, 401, 403, 429, 500) via Cloudflare edge logs.
  2. Latency percentiles (p50, p90, p99) per mobile endpoint (`/api/bot/alerts`, `/api/login`, `/api/exchange/ticker`).
  3. Client geographic distribution via Cloudflare `cf-ipcountry` and `cf-region`.
  4. Authentication churn, token refresh failures, and IP rate limiting trips.
- **What CANNOT be Observed from Existing Clients without an App Update:**
  - Native Kotlin / Java fatal crashes and stack traces.
  - Application Not Responding (ANR) events and UI thread hangs.
  - Foreground service throttles and battery optimization kills by Android OS (Doze mode).
  - Local SQLite / Room corruption or EncryptedSharedPreferences failures.
  - FCM push delivery failures that occur on-device before notification posting.

---

## 2. Target Telemetry Architecture (Phase 2 Update)

In Mobile Client v2.1.0, a lightweight, non-blocking telemetry module will be compiled into the Android client.

### 2.1 Forward-Compatible Diagnostic Payload
When an error or crash occurs, the client will send an authenticated POST request to `POST /api/client/telemetry`:

```json
{
  "source": "ANDROID",
  "severity": "CRITICAL",
  "component": "AndroidWatchdog",
  "eventType": "NATIVE_CRASH",
  "appVersion": "2.1.0",
  "backendVersion": "2.0.0",
  "errorCode": "OUT_OF_MEMORY",
  "message": "java.lang.OutOfMemoryError: Failed to allocate a 32MB bitmap",
  "evidence": {
    "deviceModel": "Google Pixel 8",
    "androidVersion": 14,
    "sdkInt": 34,
    "networkType": "WIFI",
    "batteryLevel": 0.82,
    "isForeground": true,
    "threadName": "main",
    "stackTrace": "com.cryptopulse.app.ui.chart.ChartRenderer.render(...) at line 142"
  }
}
```

### 2.2 Client Components to Implement in v2.1.0

#### Component A: CrashWatchdog (`com.cryptopulse.app.core.telemetry.CrashWatchdog`)
- Implements `Thread.UncaughtExceptionHandler`.
- Intercepts uncaught exceptions on main and background coroutine dispatchers.
- Serializes the exception into an encrypted offline buffer in app private storage (`telemetry_buffer.json`).
- On app cold-start, flushes pending crash reports asynchronously in the background.

#### Component B: NetworkTelemetryInterceptor (`com.cryptopulse.app.core.network.TelemetryInterceptor`)
- Injects standard diagnostic headers into every OkHttp request:
  - `X-App-Version: 2.1.0`
  - `X-Device-Model: Pixel 8`
  - `X-OS-Version: Android 14 (API 34)`
  - `X-Trace-Id: tr_android_uuid`
- Captures network failures (e.g. `SocketTimeoutException`, `UnknownHostException`) and queues them if failure rate exceeds 3 consecutive attempts.

#### Component C: ANR Watchdog Coroutine (`com.cryptopulse.app.core.telemetry.AnrWatchdog`)
- Periodically posts a lightweight runnable to the Android Main Looper every 5 seconds.
- If the Main Looper fails to respond within 5,000 ms, logs an `ANR_DETECTED` warning with the current main thread stack trace.

---

## 3. Backward Compatibility & Version Support Matrix

| Android Client Version | Native Crashes Observable? | ANRs Observable? | Edge HTTP Observable? | Action Required |
| :---: | :---: | :---: | :---: | :--- |
| **v1.0.0 - v2.0.0** *(Installed today)* | **NO** | **NO** | **YES** | Monitor passively via backend edge logs and `/health`. |
| **v2.1.0+** *(Next release)* | **YES** | **YES** | **YES** | Full native reporting to Centralized Monitoring Platform. |

---

## 4. Privacy & Data Protection Safeguards
The Android client telemetry interceptor will enforce:
1. **Zero Financial Leakage:** Never include wallet addresses, account balances, or trade amounts in telemetry payloads.
2. **Zero Credential Transmission:** Strip all `Authorization` headers, passwords, and exchange keys before serialization.
3. **Payload Capping:** Total serialized telemetry payload must not exceed 2 KB.
4. **Offline Queue Bound:** Maximum 10 queued reports offline; oldest evicted on overflow to protect device flash storage.
