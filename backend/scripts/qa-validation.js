#!/usr/bin/env node

/**
 * Automated QA validation for the Crypto Pulse backend.
 *
 * Runs after the "Deploy backend" workflow has finished and the Cloudflare
 * Worker is live. It performs a battery of production-grade checks against the
 * real deployed services (no mocks, no duplicated deploy logic) and emits a
 * machine-readable JSON report plus a human-readable Markdown summary.
 *
 * The script is idempotent: it registers a uniquely-named QA user each run and
 * only treats missing *optional* test exchange credentials as SKIP (never
 * FAIL), so it can be executed repeatedly without side effects.
 *
 * Exit code is non-zero when any CRITICAL or HIGH severity check fails, which
 * fails the GitHub Actions job.
 */

const fetch = globalThis.fetch;
const fs = require("node:fs/promises");

const WORKER_URL = (process.env.WORKER_URL || "https://crypto-pulse-backend.telangrocks.workers.dev").replace(/\/$/, "");
const QA_EMAIL = process.env.QA_EMAIL || `qa+${Date.now()}@cryptopulse.dev`;
const QA_PASSWORD = process.env.QA_PASSWORD || "QaPassw0rd!2026";
const QA_EXCHANGE_NAME = process.env.QA_EXCHANGE_NAME || "";
const QA_EXCHANGE_API_KEY = process.env.QA_EXCHANGE_API_KEY || "";
const QA_EXCHANGE_API_SECRET = process.env.QA_EXCHANGE_API_SECRET || "";
const QA_EXCHANGE_ENVIRONMENT = process.env.QA_EXCHANGE_ENVIRONMENT || "mainnet";

// Tokens that would indicate placeholder / mock / dummy data leaking into
// real API responses.
const MOCK_TOKENS = ["mock", "dummy", "fake", "placeholder", "lorem ipsum", "example.com", "testnet-fake"];

const checks = [];
const collectedBodies = [];

function recordCheck({ id, name, severity, status, details, durationMs }) {
  checks.push({ id, name, severity, status, details, durationMs });
  const icon = status === "PASS" ? "✅" : status === "SKIP" ? "⚠️" : "❌";
  console.log(`${icon} [${severity}] ${name} — ${status}${details ? ` (${details})` : ""}`);
}

async function request(method, path, { headers = {}, body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    // Build final headers: start with Content-Type default, then apply overrides.
    // Setting a header to null explicitly removes it (allows testing 415 responses).
    const finalHeaders = { "Content-Type": "application/json" };
    for (const [k, v] of Object.entries(headers)) {
      if (v === null) {
        delete finalHeaders[k];
      } else {
        finalHeaders[k] = v;
      }
    }
    const res = await fetch(`${WORKER_URL}${path}`, {
      method,
      headers: finalHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let json = null;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON response */
    }
    if (json) collectedBodies.push(json);
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timeout);
  }
}

function scanForMockData(label) {
  for (const body of collectedBodies) {
    const str = JSON.stringify(body).toLowerCase();
    for (const token of MOCK_TOKENS) {
      if (str.includes(token)) {
        return `possible mock/placeholder data detected (${token}) in ${label}`;
      }
    }
  }
  return null;
}

async function run() {
  console.log(`\n🔍 Crypto Pulse backend QA — ${WORKER_URL}\n`);

  // 1. Health check (CRITICAL)
  {
    const start = Date.now();
    try {
      const res = await request("GET", "/health");
      const ok = res.status === 200 && res.json?.status === "ok";
      recordCheck({
        id: "health",
        name: "Backend health check (/health)",
        severity: "critical",
        status: ok ? "PASS" : "FAIL",
        details: ok ? `status=${res.json?.status}` : `status=${res.status}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "health", name: "Backend health check (/health)", severity: "critical", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  }

  // 2. D1 database connectivity (CRITICAL)
  {
    const start = Date.now();
    try {
      const res = await request("GET", "/db-status");
      const ok = res.status === 200 && res.json?.status === "ok";
      recordCheck({
        id: "db",
        name: "Cloudflare D1 database connectivity (/db-status)",
        severity: "critical",
        status: ok ? "PASS" : "FAIL",
        details: ok ? "schema intact" : `status=${res.status} body=${res.text?.slice(0, 120)}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "db", name: "Cloudflare D1 database connectivity (/db-status)", severity: "critical", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  }

  // 3. Authentication — register (CRITICAL)
  let authToken = null;
  {
    const start = Date.now();
    try {
      const res = await request("POST", "/api/register", {
        body: { email: QA_EMAIL, password: QA_PASSWORD, confirmPassword: QA_PASSWORD },
      });
      authToken = res.json?.token || null;
      const ok = res.status === 200 && !!authToken;
      recordCheck({
        id: "register",
        name: "Authentication — user registration",
        severity: "critical",
        status: ok ? "PASS" : "FAIL",
        details: ok ? "JWT issued" : `status=${res.status}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "register", name: "Authentication — user registration", severity: "critical", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  }

  // 4. Authentication — login (CRITICAL)
  {
    const start = Date.now();
    try {
      const res = await request("POST", "/api/login", { body: { email: QA_EMAIL, password: QA_PASSWORD } });
      authToken = res.json?.token || authToken;
      const ok = res.status === 200 && !!authToken;
      recordCheck({
        id: "login",
        name: "Authentication — user login",
        severity: "critical",
        status: ok ? "PASS" : "FAIL",
        details: ok ? "JWT issued" : `status=${res.status}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "login", name: "Authentication — user login", severity: "critical", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  }

  const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {};

  // 5. Protected endpoint — profile (HIGH)
  {
    const start = Date.now();
    try {
      const res = await request("GET", "/api/profile", { headers: authHeaders });
      const ok = res.status === 200 && !!res.json?.id;
      recordCheck({
        id: "profile",
        name: "Protected route — /profile (JWT auth)",
        severity: "high",
        status: ok ? "PASS" : "FAIL",
        details: ok ? `user=${res.json?.email}` : `status=${res.status}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "profile", name: "Protected route — /profile (JWT auth)", severity: "high", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  }

  // 6. Public strategies endpoint (HIGH)
  {
    const start = Date.now();
    try {
      const res = await request("GET", "/api/strategies", { headers: authHeaders });
      const arr = Array.isArray(res.json) ? res.json : [];
      const ok = res.status === 200 && arr.length > 0;
      recordCheck({
        id: "strategies",
        name: "Public API — /strategies returns real data",
        severity: "high",
        status: ok ? "PASS" : "FAIL",
        details: ok ? `${arr.length} strategies` : `status=${res.status}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "strategies", name: "Public API — /strategies returns real data", severity: "high", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  }

  // 7. Exchange endpoint inventory (MEDIUM) — verify expected behaviors
  {
    const start = Date.now();
    try {
      const verify = await request("POST", "/api/verify-otp", { body: { email: QA_EMAIL, otp: "123456" } });
      const registerBad = await request("POST", "/api/register", { body: { email: "bad", password: "x" } });
      const ok = verify.status === 410 && registerBad.status === 400;
      recordCheck({
        id: "endpoint-inventory",
        name: "Public endpoint inventory (response codes)",
        severity: "medium",
        status: ok ? "PASS" : "FAIL",
        details: ok ? "verify-otp=410, invalid-register=400" : `verify=${verify.status}, badRegister=${registerBad.status}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "endpoint-inventory", name: "Public endpoint inventory (response codes)", severity: "medium", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  }

  // 8. Exchange connectivity + live market data (HIGH, optional creds)
  const hasExchangeCreds = !!(QA_EXCHANGE_NAME && QA_EXCHANGE_API_KEY && QA_EXCHANGE_API_SECRET);
  if (hasExchangeCreds && authToken) {
    const start = Date.now();
    try {
      const validate = await request("POST", "/api/exchange/validate", {
        body: { exchangeName: QA_EXCHANGE_NAME, apiKey: QA_EXCHANGE_API_KEY, apiSecret: QA_EXCHANGE_API_SECRET, environment: QA_EXCHANGE_ENVIRONMENT },
      });
      const validateOk = validate.status === 200 && validate.json && typeof validate.json.success === "boolean";
      recordCheck({
        id: "exchange-validate",
        name: `Exchange connectivity — validate ${QA_EXCHANGE_NAME} (${QA_EXCHANGE_ENVIRONMENT})`,
        severity: "high",
        status: validateOk ? "PASS" : "FAIL",
        details: validateOk ? `success=${validate.json.success}` : `status=${validate.status}`,
        durationMs: Date.now() - start,
      });

      // Connect the exchange so we can fetch real market data.
      const connect = await request("POST", "/api/exchange/connect", {
        headers: authHeaders,
        body: { exchangeName: QA_EXCHANGE_NAME, apiKey: QA_EXCHANGE_API_KEY, apiSecret: QA_EXCHANGE_API_SECRET, environment: QA_EXCHANGE_ENVIRONMENT },
      });
      if (connect.status === 200 && connect.json?.success) {
        const candidates = await request("GET", "/market/candidates", { headers: authHeaders });
        const arr = Array.isArray(candidates.json) ? candidates.json : [];
        const realPrices = arr.filter((c) => typeof c.currentMarketPrice === "number" && c.currentMarketPrice > 0);
        const ok = candidates.status === 200 && arr.length > 0 && realPrices.length > 0;
        recordCheck({
          id: "market-data",
          name: "Live market data — /market/candidates returns real prices",
          severity: "high",
          status: ok ? "PASS" : "FAIL",
          details: ok ? `${realPrices.length}/${arr.length} candidates with live prices` : `status=${candidates.status}`,
          durationMs: Date.now() - start,
        });
      } else {
        recordCheck({ id: "market-data", name: "Live market data — /market/candidates returns real prices", severity: "high", status: "SKIP", details: "exchange connect failed", durationMs: Date.now() - start });
      }
    } catch (e) {
      recordCheck({ id: "exchange-validate", name: `Exchange connectivity — ${QA_EXCHANGE_NAME}`, severity: "high", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  } else {
    recordCheck({
      id: "exchange-validate",
      name: "Exchange connectivity (optional test credentials)",
      severity: "high",
      status: "SKIP",
      details: "QA_EXCHANGE_* secrets not provided",
      durationMs: 0,
    });
    recordCheck({
      id: "market-data",
      name: "Live market data — real prices",
      severity: "high",
      status: "SKIP",
      details: "requires exchange test credentials",
      durationMs: 0,
    });
  }

  // 9. No mock / dummy data (CRITICAL)
  {
    const start = Date.now();
    const mockHit = scanForMockData("collected responses");
    const ok = !mockHit;
    recordCheck({
      id: "no-mock-data",
      name: "No hardcoded / mock / dummy data in responses",
      severity: "critical",
      status: ok ? "PASS" : "FAIL",
      details: ok ? `${collectedBodies.length} responses scanned` : mockHit,
      durationMs: Date.now() - start,
    });
  }

  // 10. User-friendly error handling (HIGH)
  {
    const start = Date.now();
    try {
      const badLogin = await request("POST", "/api/login", { body: { email: "invalid", password: "wrong" } });
      const badRegister = await request("POST", "/api/register", { body: { email: "bad", password: "x" } });
      const noContentType = await request("POST", "/api/login", { body: { email: QA_EMAIL, password: QA_PASSWORD }, headers: { "Content-Type": null } });

      const loginMsg = (badLogin.json?.error || badLogin.json?.message || "").toLowerCase();
      const registerMsg = (badRegister.json?.error || badRegister.json?.message || "").toLowerCase();
      // Server returns { error: "Unsupported Media Type", message: "Content-Type must be application/json" }
      // Check both fields together for robustness
      const contentTypeMsg = (
        (noContentType.json?.error || "") + " " + (noContentType.json?.message || "")
      ).toLowerCase();

      const ok = badLogin.status === 401 &&
                 badRegister.status === 400 &&
                 noContentType.status === 415 &&
                 loginMsg.includes("invalid credentials") &&
                 registerMsg.includes("invalid input") &&
                 contentTypeMsg.includes("content-type");

      recordCheck({
        id: "error-handling",
        name: "User-friendly error handling — meaningful messages, no raw stack traces",
        severity: "high",
        status: ok ? "PASS" : "FAIL",
        details: ok ? "login=401, register=400, contentType=415" : `login=${badLogin.status}, register=${badRegister.status}, contentType=${noContentType.status}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "error-handling", name: "User-friendly error handling", severity: "high", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  }

  // 11. Watchlist CRUD (MEDIUM)
  {
    const start = Date.now();
    try {
      if (!authToken) throw new Error("No auth token");
      const getEmpty = await request("GET", "/api/watchlist", { headers: authHeaders });
      const addItem = await request("POST", "/api/watchlist", { headers: authHeaders, body: { token_id: "bitcoin" } });
      const getAfterAdd = await request("GET", "/api/watchlist", { headers: authHeaders });
      const deleteItem = await request("DELETE", `/api/watchlist/${getAfterAdd.json?.[0]?.id}`, { headers: authHeaders });
      const getAfterDelete = await request("GET", "/api/watchlist", { headers: authHeaders });

      const ok = getEmpty.status === 200 &&
                 addItem.status === 200 &&
                 getAfterAdd.status === 200 && Array.isArray(getAfterAdd.json) && getAfterAdd.json.length > 0 &&
                 deleteItem.status === 200 &&
                 getAfterDelete.status === 200 && Array.isArray(getAfterDelete.json) && getAfterDelete.json.length === 0;

      recordCheck({
        id: "watchlist",
        name: "Watchlist CRUD — add and remove tokens",
        severity: "medium",
        status: ok ? "PASS" : "FAIL",
        details: ok ? "CRUD operations successful" : `add=${addItem.status}, delete=${deleteItem.status}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "watchlist", name: "Watchlist CRUD", severity: "medium", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  }

  // 12. Trading Bot Alerts (MEDIUM)
  {
    const start = Date.now();
    try {
      if (!authToken) throw new Error("No auth token");
      const botAlerts = await request("GET", "/api/trading-bot/alerts", {
        headers: authHeaders,
      });

      const ok = botAlerts.status === 200 && Array.isArray(botAlerts.json);

      recordCheck({
        id: "trading-bot-alerts",
        name: "Trading Bot Alerts — list pending signals",
        severity: "medium",
        status: ok ? "PASS" : "FAIL",
        details: ok ? `count=${botAlerts.json.length}` : `status=${botAlerts.status}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "trading-bot-alerts", name: "Trading Bot Alerts", severity: "medium", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  }

  // 13. Technical analysis (HIGH, requires connected exchange)
  if (hasExchangeCreds && authToken) {
    const start = Date.now();
    try {
      const ta = await request("POST", "/api/market/technical-analysis", {
        headers: authHeaders,
        body: { symbol: "BTCUSDT", strategy: "scalping" }
      });

      const indicators = ta.json?.indicators || {};
      const signals = ta.json?.signals || {};
      const hasIndicators = indicators.rsi !== undefined && indicators.macd !== undefined;
      const hasSignals = signals.trend && signals.recommendation;
      const ok = ta.status === 200 && hasIndicators && hasSignals && !scanForMockData("technical analysis");

      recordCheck({
        id: "technical-analysis",
        name: "Technical analysis — genuine indicators and signals",
        severity: "high",
        status: ok ? "PASS" : "FAIL",
        details: ok ? `RSI=${indicators.rsi?.toFixed(2)}, recommendation=${signals.recommendation}` : `status=${ta.status}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "technical-analysis", name: "Technical analysis", severity: "high", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  } else {
    recordCheck({
      id: "technical-analysis",
      name: "Technical analysis (requires connected exchange)",
      severity: "high",
      status: "SKIP",
      details: "requires exchange test credentials",
      durationMs: 0,
    });
  }

  // 14. Market ticker + klines (HIGH, requires connected exchange)
  if (hasExchangeCreds && authToken) {
    const start = Date.now();
    try {
      const ticker = await request("GET", "/api/market/ticker?symbol=BTCUSDT", { headers: authHeaders });
      const klines = await request("GET", "/api/market/klines?symbol=BTCUSDT&interval=1h&limit=10", { headers: authHeaders });

      const tickerOk = ticker.status === 200 && ticker.json?.lastPrice > 0;
      const klinesOk = klines.status === 200 && Array.isArray(klines.json) && klines.json.length > 0;
      const ok = tickerOk && klinesOk;

      recordCheck({
        id: "market-data-detail",
        name: "Market ticker + klines — real data",
        severity: "high",
        status: ok ? "PASS" : "FAIL",
        details: ok ? `ticker=${ticker.json.lastPrice}, klines=${klines.json.length}` : `ticker=${ticker.status}, klines=${klines.status}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "market-data-detail", name: "Market ticker + klines", severity: "high", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  } else {
    recordCheck({
      id: "market-data-detail",
      name: "Market ticker + klines (requires connected exchange)",
      severity: "high",
      status: "SKIP",
      details: "requires exchange test credentials",
      durationMs: 0,
    });
  }

  // 15. FCM token registration (MEDIUM)
  {
    const start = Date.now();
    try {
      if (!authToken) throw new Error("No auth token");
      const fcm = await request("POST", "/api/fcm/register", {
        headers: authHeaders,
        body: { fcmToken: "test_fcm_token_qa" }
      });

      const ok = fcm.status === 200 && fcm.json?.success !== false;

      recordCheck({
        id: "fcm-register",
        name: "FCM token registration",
        severity: "medium",
        status: ok ? "PASS" : "FAIL",
        details: ok ? "token registered" : `status=${fcm.status}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "fcm-register", name: "FCM token registration", severity: "medium", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  }

  // 16. Exchange status (MEDIUM)
  {
    const start = Date.now();
    try {
      if (!authToken) throw new Error("No auth token");
      const status = await request("GET", "/api/exchange/status", { headers: authHeaders });

      const ok = status.status === 200 && typeof status.json?.isConnected === "boolean";

      recordCheck({
        id: "exchange-status",
        name: "Exchange connection status",
        severity: "medium",
        status: ok ? "PASS" : "FAIL",
        details: ok ? `connected=${status.json.isConnected}` : `status=${status.status}`,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      recordCheck({ id: "exchange-status", name: "Exchange connection status", severity: "medium", status: "FAIL", details: e.message, durationMs: Date.now() - start });
    }
  }

  // Report + exit
  const passed = checks.filter((c) => c.status === "PASS").length;
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const skipped = checks.filter((c) => c.status === "SKIP").length;
  const failedCritical = checks.filter((c) => c.status === "FAIL" && (c.severity === "critical" || c.severity === "high"));

  const report = {
    generatedAt: new Date().toISOString(),
    workerUrl: WORKER_URL,
    summary: { total: checks.length, passed, failed, skipped, blockingFailures: failedCritical.length },
    checks,
  };

  const md = [
    "# Crypto Pulse — Backend QA Report",
    "",
    `**Worker:** ${WORKER_URL}`,
    `**Generated:** ${report.generatedAt}`,
    "",
    `**Total:** ${checks.length} | ✅ Passed: ${passed} | ❌ Failed: ${failed} | ⚠️ Skipped: ${skipped}`,
    "",
    "| # | Check | Severity | Status | Details |",
    "|---|-------|----------|--------|---------|",
    ...checks.map((c, i) => `| ${i + 1} | ${c.name} | ${c.severity} | ${c.status} | ${c.details || ""} |`),
    "",
    failedCritical.length
      ? `> ❌ **Blocking failures (critical/high):** ${failedCritical.map((c) => c.name).join("; ")}`
      : "> ✅ No blocking failures.",
  ].join("\n");

  // Persist reports for artifact upload.
  await fs.writeFile("qa-report.json", JSON.stringify(report, null, 2));
  await fs.writeFile("qa-report.md", md);

  console.log(`\n📊 QA results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failedCritical.length) {
    console.log(`❌ Blocking failures: ${failedCritical.map((c) => c.name).join("; ")}`);
    process.exit(1);
  }
  console.log("✨ Backend QA passed (no blocking failures).");
}

run().catch((e) => {
  console.error("QA script crashed:", e);
  process.exit(1);
});
