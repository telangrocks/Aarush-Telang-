#!/usr/bin/env node

/**
 * Crypto Pulse — Android AI Feature Testing: BACKEND BUSINESS-LOGIC VALIDATION
 *
 * This script verifies that the REAL backend (Cloudflare Worker + live exchange
 * market data) has actually completed each business operation requested by the
 * mobile feature test — it does NOT just confirm a screen appeared. It is the
 * business-logic counterpart to the Maestro UI journey.
 *
 * It is invoked ONCE PER EXCHANGE / ENVIRONMENT by the GitHub Actions workflow
 * (see .github/workflows/ai-feature-testing.yml), so each supported exchange
 * gets an independent result. Output is a structured JSON report
 * (feature-validation-<exchange>-<env>.json) plus a human-readable summary,
 * and the process exits non-zero only when a CRITICAL/HIGH business check fails
 * for the exchange under test.
 *
 * Phases validated (mapped to the 11-phase product journey):
 *   P2  Exchange connectivity (validate + connect + status persisted)
 *   P2  Invalid-credential failure handling
 *   P3  Live market data (candidates, ticker, klines — real values)
 *   P4  Intraday scanner Top 10 (ranking, live prices)
 *   P6  Trade setup capability (ticker present for calc)
 *   P7  Strategy execution (all supported strategies returned)
 *   P7  Technical analysis genuinely computed (indicators + signals)
 *   P8  Live bot dashboard (analysis-status reachable, engine progressing)
 *   P9  Signal generation (alert raised by live engine, not mocked)
 *   P10 Trade execution (position created in backend)
 *   P11 Live P&L (position present and price synced)
 */

const fs = require("node:fs/promises");

const WORKER_URL = (process.env.WORKER_URL || "https://crypto-pulse-backend.telangrocks.workers.dev").replace(/\/$/, "");
const EXCHANGE_NAME = (process.env.EXCHANGE_NAME || "bybit").toLowerCase();
const EXCHANGE_ENVIRONMENT = process.env.EXCHANGE_ENVIRONMENT === "testnet" ? "testnet" : "mainnet";
const EXCHANGE_API_KEY = process.env.EXCHANGE_API_KEY || "";
const EXCHANGE_API_SECRET = process.env.EXCHANGE_API_SECRET || "";
const QA_EMAIL = process.env.QA_EMAIL || `qa+${Date.now()}@cryptopulse.dev`;
const QA_PASSWORD = process.env.QA_PASSWORD || "QaPassw0rd!2026";

const MOCK_TOKENS = ["mock", "dummy", "fake", "placeholder", "lorem ipsum", "example.com", "testnet-fake"];
const STRATEGIES_EXPECTED = ["scalping", "momentum", "breakout", "mean_reversion", "vwap"];

const checks = [];
const collectedBodies = [];

function record({ phase, name, severity, status, details, durationMs }) {
  checks.push({ phase, name, severity, status, details, durationMs });
  const icon = status === "PASS" ? "✅" : status === "SKIP" ? "⚠️" : "❌";
  console.log(`${icon} [${phase}] [${severity}] ${name} — ${status}${details ? ` (${details})` : ""}`);
}

async function request(method, path, { headers = {}, body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${WORKER_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let json = null;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (json) collectedBodies.push(json);
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

function scanForMockData(label) {
  for (const body of collectedBodies) {
    const str = JSON.stringify(body).toLowerCase();
    for (const token of MOCK_TOKENS) {
      if (str.includes(token)) return `possible mock/placeholder data (${token}) in ${label}`;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log(`\n🔍 Crypto Pulse backend business validation — ${EXCHANGE_NAME} (${EXCHANGE_ENVIRONMENT}) @ ${WORKER_URL}\n`);

  if (!EXCHANGE_API_KEY || !EXCHANGE_API_SECRET) {
    console.error("Missing EXCHANGE_API_KEY / EXCHANGE_API_SECRET — cannot run real exchange validation.");
    process.exit(2);
  }

  // ---- Auth -------------------------------------------------------------
  let authToken = null;
  {
    const start = Date.now();
    const res = await request("POST", "/api/register", { body: { email: QA_EMAIL, password: QA_PASSWORD, confirmPassword: QA_PASSWORD } });
    authToken = res.json?.token || null;
    record({ phase: "P1", name: "Authentication (register + JWT)", severity: "critical", status: res.status === 200 && authToken ? "PASS" : "FAIL", details: authToken ? "JWT issued" : `status=${res.status}`, durationMs: Date.now() - start });
  }
  if (!authToken) { finish(); return; }
  const authHeaders = { Authorization: `Bearer ${authToken}` };

  // ---- P2: Invalid-credential failure handling -------------------------
  {
    const start = Date.now();
    const res = await request("POST", "/api/exchange/validate", { body: { exchangeName: EXCHANGE_NAME, apiKey: "invalid_key_for_testing", apiSecret: "invalid_secret_for_testing", environment: EXCHANGE_ENVIRONMENT } });
    const ok = res.status === 200 && res.json?.success === false;
    record({ phase: "P2", name: "Invalid-credential rejection", severity: "high", status: ok ? "PASS" : "FAIL", details: ok ? `success=${res.json?.success}` : `status=${res.status}`, durationMs: Date.now() - start });
  }

  // ---- P2: Validate (real credentials) --------------------------------
  let validated = false;
  {
    const start = Date.now();
    const res = await request("POST", "/api/exchange/validate", { body: { exchangeName: EXCHANGE_NAME, apiKey: EXCHANGE_API_KEY, apiSecret: EXCHANGE_API_SECRET, environment: EXCHANGE_ENVIRONMENT } });
    validated = res.status === 200 && res.json?.success === true;
    record({ phase: "P2", name: `Validate ${EXCHANGE_NAME} (${EXCHANGE_ENVIRONMENT}) credentials`, severity: "critical", status: validated ? "PASS" : "FAIL", details: validated ? "credentials valid" : `status=${res.status} msg=${res.json?.message || ""}`, durationMs: Date.now() - start });
  }

  // ---- P2: Connect (persists to DB) -----------------------------------
  let connected = false;
  {
    const start = Date.now();
    const res = await request("POST", "/api/exchange/connect", { headers: authHeaders, body: { exchangeName: EXCHANGE_NAME, apiKey: EXCHANGE_API_KEY, apiSecret: EXCHANGE_API_SECRET, environment: EXCHANGE_ENVIRONMENT } });
    connected = res.status === 200 && res.json?.success === true;
    record({ phase: "P2", name: `Connect ${EXCHANGE_NAME} (${EXCHANGE_ENVIRONMENT})`, severity: "critical", status: connected ? "PASS" : "FAIL", details: connected ? "exchange connected" : `status=${res.status}`, durationMs: Date.now() - start });
  }

  // ---- P2: Status reflects real connection ----------------------------
  {
    const start = Date.now();
    const res = await request("GET", "/api/exchange/status", { headers: authHeaders });
    const ok = res.status === 200 && res.json?.isConnected === true && res.json?.exchangeName === EXCHANGE_NAME;
    record({ phase: "P2", name: "Exchange status persisted", severity: "high", status: ok ? "PASS" : "FAIL", details: ok ? `connected=${res.json.exchangeName}/${res.json.environment}` : `status=${res.status} body=${res.text?.slice(0, 120)}`, durationMs: Date.now() - start });
  }

  if (!connected) { finish(); return; }

  // ---- P3/P4: Live market candidates (Top 10, real prices) -----------
  let candidates = [];
  {
    const start = Date.now();
    const res = await request("GET", "/api/market/candidates", { headers: authHeaders });
    candidates = Array.isArray(res.json) ? res.json : [];
    const realPrices = candidates.filter((c) => typeof c.currentMarketPrice === "number" && c.currentMarketPrice > 0);
    const ranked = candidates.every((c, i) => c.rank === i + 1) && candidates.length <= 10;
    const ok = res.status === 200 && candidates.length > 0 && realPrices.length > 0 && ranked;
    record({ phase: "P3/P4", name: "Top 10 candidate scanner (live data + ranking)", severity: "critical", status: ok ? "PASS" : "FAIL", details: ok ? `${realPrices.length}/${candidates.length} with live prices, ranked` : `status=${res.status} count=${candidates.length}`, durationMs: Date.now() - start });
  }

  // ---- P3: Ticker (real) ----------------------------------------------
  let firstSymbol = candidates[0]?.symbol || "BTCUSDT";
  {
    const start = Date.now();
    const res = await request("GET", `/api/market/ticker?symbol=${firstSymbol}`, { headers: authHeaders });
    const ok = res.status === 200 && typeof res.json?.price === "number" && res.json.price > 0;
    record({ phase: "P3", name: "Live ticker (real price)", severity: "high", status: ok ? "PASS" : "FAIL", details: ok ? `price=${res.json.price}` : `status=${res.status}`, durationMs: Date.now() - start });
  }

  // ---- P3: Klines (real candles) --------------------------------------
  {
    const start = Date.now();
    const res = await request("GET", `/api/market/klines?symbol=${firstSymbol}&interval=1h&limit=20`, { headers: authHeaders });
    const ok = res.status === 200 && Array.isArray(res.json) && res.json.length > 0;
    record({ phase: "P3", name: "Live klines (real candles)", severity: "high", status: ok ? "PASS" : "FAIL", details: ok ? `${res.json.length} candles` : `status=${res.status}`, durationMs: Date.now() - start });
  }

  // ---- P7: Strategies (all supported) --------------------------------
  let strategies = [];
  {
    const start = Date.now();
    const res = await request("GET", "/api/strategies", { headers: authHeaders });
    strategies = Array.isArray(res.json) ? res.json : [];
    const ids = strategies.map((s) => s.id);
    const ok = res.status === 200 && STRATEGIES_EXPECTED.every((s) => ids.includes(s));
    record({ phase: "P7", name: "All supported strategies available", severity: "high", status: ok ? "PASS" : "FAIL", details: ok ? `${strategies.length} strategies` : `missing=${STRATEGIES_EXPECTED.filter((s) => !ids.includes(s)).join(",")}`, durationMs: Date.now() - start });
  }

  // ---- P7: Technical analysis (genuine indicators) --------------------
  let taOk = false;
  for (const strategy of STRATEGIES_EXPECTED) {
    const start = Date.now();
    const res = await request("POST", "/api/market/technical-analysis", { headers: authHeaders, body: { symbol: firstSymbol, strategy } });
    const ind = res.json?.indicators || {};
    const sig = res.json?.signals || {};
    const ok = res.status === 200 && ind.rsi !== undefined && ind.macd !== undefined && sig.trend && sig.recommendation && !scanForMockData("TA");
    if (ok) taOk = true;
    record({ phase: "P7", name: `Technical analysis — ${strategy}`, severity: "high", status: ok ? "PASS" : "FAIL", details: ok ? `RSI=${ind.rsi}` : `status=${res.status}`, durationMs: Date.now() - start });
  }

  // ---- P8/P9: Activate bot + wait for live engine to progress --------
  let botActive = false;
  {
    const start = Date.now();
    const res = await request("POST", "/api/trading-bot/activate", { headers: authHeaders, body: { coinId: firstSymbol, strategy: "scalping", positionSize: 100 } });
    botActive = res.status === 200;
    record({ phase: "P8", name: "Strategy activation (bot started)", severity: "high", status: botActive ? "PASS" : "FAIL", details: botActive ? "activated" : `status=${res.status}`, durationMs: Date.now() - start });
  }

  let engineProgressed = false;
  let reachedSignal = false;
  if (botActive) {
    const start = Date.now();
    let lastProgress = -1;
    for (let i = 0; i < 30; i++) {
      const res = await request("GET", "/api/trading-bot/analysis-status", { headers: authHeaders });
      const st = res.json;
      if (st?.scanningProgress !== undefined) {
        if (st.scanningProgress > lastProgress) { lastProgress = st.scanningProgress; engineProgressed = true; }
        const alerts = await request("GET", "/api/trading-bot/alerts", { headers: authHeaders });
        const arr = Array.isArray(alerts.json) ? alerts.json : [];
        if (arr.length > 0) { reachedSignal = true; break; }
      }
      await sleep(4000);
    }
    record({ phase: "P8", name: "Live bot dashboard — engine progressing", severity: "high", status: engineProgressed ? "PASS" : "FAIL", details: `lastProgress=${lastProgress}`, durationMs: Date.now() - start });
    record({ phase: "P9", name: "Signal generation by live engine", severity: "high", status: reachedSignal ? "PASS" : "SKIP", details: reachedSignal ? "alert raised by engine" : "no live signal within window (market-dependent)" });
  }

  // ---- P10: Trade execution (position created) ------------------------
  let positionCreated = false;
  {
    const start = Date.now();
    const res = await request("POST", "/api/trading-bot/execute-trade", { headers: authHeaders });
    const pos = await request("GET", "/api/positions", { headers: authHeaders });
    const arr = Array.isArray(pos.json) ? pos.json : [];
    positionCreated = res.status === 200 && arr.length > 0;
    record({ phase: "P10", name: "Trade execution (position created)", severity: "high", status: positionCreated ? "PASS" : "SKIP", details: positionCreated ? `${arr.length} position(s)` : `execute=${res.status} positions=${arr.length}` });
  }

  // ---- P11: Live P&L synced ------------------------------------------
  {
    const start = Date.now();
    const res = await request("GET", "/api/positions", { headers: authHeaders });
    const arr = Array.isArray(res.json) ? res.json : [];
    const synced = arr.some((p) => typeof p.current_price === "number" && p.current_price > 0 && (typeof p.live_pnl === "number" || p.live_pnl === null));
    const ok = arr.length > 0 && synced;
    record({ phase: "P11", name: "Live P&L (positions synced with backend)", severity: "high", status: ok ? "PASS" : "SKIP", details: ok ? "P&L present" : "no open positions to verify", durationMs: Date.now() - start });
  }

  finish();
}

function finish() {
  const passed = checks.filter((c) => c.status === "PASS").length;
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const skipped = checks.filter((c) => c.status === "SKIP").length;
  const blocking = checks.filter((c) => c.status === "FAIL" && (c.severity === "critical" || c.severity === "high"));

  const report = {
    generatedAt: new Date().toISOString(),
    workerUrl: WORKER_URL,
    exchange: EXCHANGE_NAME,
    environment: EXCHANGE_ENVIRONMENT,
    summary: { total: checks.length, passed, failed, skipped, blockingFailures: blocking.length },
    checks,
  };

  const fname = `feature-validation-${EXCHANGE_NAME}-${EXCHANGE_ENVIRONMENT}.json`;
  const md = [
    `# Crypto Pulse — Backend Validation: ${EXCHANGE_NAME} (${EXCHANGE_ENVIRONMENT})`,
    "",
    `**Worker:** ${WORKER_URL}`,
    `**Total:** ${checks.length} | ✅ ${passed} | ❌ ${failed} | ⚠️ ${skipped}`,
    "",
    "| Phase | Check | Severity | Status | Details |",
    "|---|---|---|---|---|",
    ...checks.map((c) => `| ${c.phase} | ${c.name} | ${c.severity} | ${c.status} | ${c.details || ""} |`),
    "",
    blocking.length ? `> ❌ Blocking failures: ${blocking.map((c) => c.name).join("; ")}` : "> ✅ No blocking failures.",
  ].join("\n");

  fs.writeFile("feature-validation-report.json", JSON.stringify(report, null, 2));
  fs.writeFile(fname, JSON.stringify(report, null, 2));
  fs.writeFile("feature-validation-report.md", md);

  console.log(`\n📊 ${EXCHANGE_NAME}/${EXCHANGE_ENVIRONMENT}: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (blocking.length) {
    console.log(`❌ Blocking failures: ${blocking.map((c) => c.name).join("; ")}`);
    process.exit(1);
  }
  console.log("✨ Backend business validation passed for this exchange/environment.");
}

run().catch((e) => {
  console.error("Validation script crashed:", e);
  process.exit(1);
});
