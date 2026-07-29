# Production Validation Framework Documentation

This document describes the design, architecture, phase definitions, SLA thresholds, security redactions, and deployment gate decisions for the **Crypto Pulse Production Validation Framework**.

---

## 1. Overview & Purpose

The pipeline operates under a single core directive:
> **"The pipeline's purpose is not to prove success—it is to discover reasons why the bot is not yet safe for production."**

Instead of scripted test steps that output synthetic pass messages, the framework executes real code against real APIs, measures performance SLAs, tests failure scenarios, audits state recovery, sanitizes sensitive data, and renders an objective deployment gate decision on `$GITHUB_STEP_SUMMARY`.

---

## 2. Validation Levels & Mainnet Safeguard

- **Level 1 (`level1_public`):** Non-destructive, zero credentials required. Runs on every commit and pull request. Validates backend health, D1 schema, public market data, indicator math, 5-strategy determinism, risk calculations, order quantization, and security redaction.
- **Level 2 (`level2_testnet`):** Runs when testnet exchange secrets are present in CI. Validates testnet authentication, balances, testnet order placement/cancellation/OCO, status tracking, and notification delivery.
- **Level 3 (`level3_prod_smoke`):** Manually triggered (`workflow_dispatch`) only. Runs **strictly non-destructive checks** (auth, balances, symbol metadata, permissions). **NEVER places mainnet orders automatically.**

---

## 3. The 11 Isolated Validation Phases

```text
Phase 0: Environment & Clock Sync Pre-flight Gate
Phase 1: Infrastructure & Dependency Health (Non-Functional)
Phase 2: Authentication & JWT Token Lifecycle (Functional)
Phase 3: Exchange Connectivity & Permissions Audit (Functional & Non-Functional)
Phase 4: Market Data Freshness & Timestamps (Functional)
Phase 5: Strategy Engine Quality & Determinism (Functional)
Phase 6: Risk Engine & Bounds Refusal (Functional)
Phase 7: Order Engine & Live Symbol Rule Quantization (Functional)
Phase 8: D1 Database & Persistence Audit (Functional)
Phase 9: Process Recovery & Restart Simulation (Non-Functional)
Phase 10: Notifications & Security Redaction Audit (Functional & Non-Functional)
```

---

## 4. Configurable SLA Thresholds

SLAs are configured in `backend/scripts/validation/config/ValidationConfig.ts` and can be overridden via environment variables:

| SLA Metric | Environment Variable | Default Threshold |
| :--- | :--- | :--- |
| Worker API Latency | `SLA_WORKER_LATENCY_MS` | **3500ms** |
| D1 Query Latency | `SLA_DB_LATENCY_MS` | **3500ms** |
| Exchange API Latency | `SLA_EXCHANGE_API_LATENCY_MS` | **1500ms** |
| Kline Fetch Latency | `SLA_KLINE_FETCH_LATENCY_MS` | **1500ms** |
| Strategy Evaluation Time | `SLA_STRATEGY_EVAL_LATENCY_MS` | **50ms** |
| Risk Calculation Time | `SLA_RISK_CALC_LATENCY_MS` | **20ms** |
| System Clock Drift | `SLA_MAX_CLOCK_DRIFT_MS` | **1000ms** |
| Heap Memory Limit | `SLA_MAX_MEMORY_MB` | **512MB** |
| Kline Stale Age Limit | `SLA_MAX_KLINE_STALE_AGE_SEC` | **60s** |

---

## 5. Machine-Readable Artifacts

Every run exports 5 JSON reports and 1 Markdown report to the `reports/` directory:
- `validation-report.json`: Master execution summary and pass/fail assertions.
- `performance-report.json`: Latency metrics and SLA compliance details.
- `exchange-report.json`: System clock drift and symbol price data.
- `strategy-report.json`: 5-strategy execution log and determinism audit.
- `risk-report.json`: Risk engine evaluation and bounds refusal assertions.
- `production-readiness.md`: Markdown summary appended to `$GITHUB_STEP_SUMMARY`.

---

## 6. How to Run Locally

```bash
# Run Level 1 Public Validation Suite
npx tsx scripts/validation/runner.ts --level=level1_public

# Run Level 2 Testnet Validation Suite
npx tsx scripts/validation/runner.ts --level=level2_testnet
```
