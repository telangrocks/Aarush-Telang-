# Performance Baseline — Strategy Evaluation Platform

## Document Purpose
This document is the **permanent production baseline** for the Strategy Evaluation Platform.
All future performance regressions must be measured against these numbers before any optimization is accepted.

---

## Benchmark Environment

| Property          | Value                                                           |
|-------------------|-----------------------------------------------------------------|
| Platform          | Windows 11                                                      |
| Node.js Version   | Node.js runtime via `vitest bench` (Vitest v1.6.1)              |
| CPU               | Consumer-grade x86-64 (developer workstation)                  |
| Benchmark Tool    | Vitest Bench (experimental, Tinybench under the hood)           |
| Benchmark Date    | 2026-07-20                                                      |
| Commit Hash       | `ab77dd10f88a664b7f741e43c4515146a0ee1d33`                     |
| Market Data       | 100 candles per timeframe (5m, 15m, 1h) — synthetic OHLCV      |

---

## Benchmark Methodology

All benchmarks were run with a **pre-warmed, in-process singleton** `StrategyRegistry`.
Each evaluation creates a new frozen `StrategyContext` per iteration to simulate realistic production behavior where the context is rebuilt each alarm cycle.
Benchmarks are designed to measure pure in-process computation (no network, no I/O, no database).

---

## Results: Individual Strategy Evaluation

Each strategy evaluated against a single frozen `StrategyContext` with 100 candles.

| Strategy       | ops/sec    | Mean (ms) | Min (ms) | Max (ms) | P99 (ms) | ±RME   | Samples |
|----------------|-----------|-----------|----------|----------|----------|--------|---------|
| ScalperV2      | 10,338    | 0.0967    | 0.0705   | 2.6640   | 0.3140   | ±1.71% | 5,169   |
| Momentum       | 8,653     | 0.1156    | 0.0708   | 2.2035   | 0.5086   | ±2.43% | 4,327   |
| Breakout       | 9,367     | 0.1068    | 0.0706   | 4.4589   | 0.3125   | ±2.36% | 4,684   |
| MeanReversion  | 9,437     | 0.1060    | 0.0711   | 1.2096   | 0.3011   | ±1.31% | 4,720   |
| VWAP           | 10,920    | 0.0916    | 0.0711   | 0.8011   | 0.2705   | ±1.10% | 5,460   |

**Key Finding:** All strategies evaluate in under **0.12ms on average** — well within the production alarm cycle budget of 15 seconds.
VWAP is the fastest (10,920 ops/sec). Momentum is the slowest but still exceeds **8,600 ops/sec**.

---

## Results: Combined 5-Strategy Evaluation

All 5 strategies evaluated sequentially on the same frozen `StrategyContext`.

| Test                             | ops/sec   | Mean (ms) | Min (ms) | Max (ms) | P99 (ms) | ±RME   | Samples |
|----------------------------------|-----------|-----------|----------|----------|----------|--------|---------|
| All 5 strategies on 1 snapshot   | 2,248     | 0.4449    | 0.3631   | 2.4374   | 0.8242   | ±1.51% | 1,124   |

**Key Finding:** Evaluating all 5 strategies in a single alarm cycle completes in **~0.44ms** on average.
At the 15-second alarm interval, this leaves 99.997% of the cycle budget available for I/O and network operations.

---

## Results: Symbol-Scale Evaluation

All 5 strategies evaluated against N unique `MarketSnapshots` to simulate a multi-symbol scan.

| Scale                   | ops/sec  | Mean (ms) | Min (ms) | Max (ms) | P99 (ms)  | ±RME   | Samples |
|-------------------------|---------|-----------|----------|----------|-----------|--------|---------|
| 10 symbols × 5 strategies  | 213.9   | 4.68      | 3.83     | 5.96     | 5.94      | ±2.18% | 107     |
| 25 symbols × 5 strategies  | 89.7    | 11.15     | 10.29    | 13.82    | 13.82     | ±2.16% | 45      |
| 50 symbols × 5 strategies  | 41.9    | 23.87     | 21.08    | 29.23    | 29.23     | ±4.86% | 21      |
| 100 symbols × 5 strategies | 18.9    | 52.98     | 43.43    | 65.38    | 65.38     | ±8.53% | 10      |

**Key Finding:** Even at **100 symbols × 5 strategies**, total in-process computation is **~53ms**,
leaving over **14.9 seconds** of the 15-second alarm window for data fetching and I/O.
The evaluation engine is NOT a bottleneck at current scale.

---

## Phase 6 — Performance Tuning Decision

> **No optimization was applied because profiling did not reveal a meaningful bottleneck.**

All individual strategy evaluations complete in under 0.12ms.
100-symbol multi-strategy evaluation completes in ~53ms.
The production alarm cycle is 15,000ms.
Computation represents < 0.4% of the available cycle budget.

Premature optimization would risk introducing logic changes while providing zero measurable user benefit.
If symbol scan volume grows beyond ~1,000 symbols in a future release, parallelization via `Promise.all` batching should be re-evaluated at that time.

---

## Before/After Comparison Table

| Metric                         |  Before Sprint 15 | After Sprint 15 | Improvement |
|--------------------------------|------------------|-----------------|-------------|
| Single strategy avg (ms)       | N/A (not measured) | 0.096–0.116 ms | **Baseline established** |
| 5-strategy combined avg (ms)   | N/A (not measured) | 0.44 ms         | **Baseline established** |
| 100 symbols × 5 strategies (ms)| N/A (not measured) | 52.98 ms        | **Baseline established** |
| Memory stability               | Not validated    | Validated (1000-event cap, circular buffer) | **Hardened** |
| Plugin failure isolation       | Partial (try/catch in orchestrator) | Fully validated with telemetry | **Hardened** |
| DO recovery simulation         | Not validated    | Validated (registry rebuild) | **Validated** |

---

## Notes

- Benchmark was run in **DEV** mode (Vitest hot module reloading). Production V8 JIT compilation in a Cloudflare Worker runtime will produce different (typically faster) numbers.
- Benchmarks should be re-run before any optimization is applied in future sprints.
- The `±RME` (relative margin of error) for 100-symbol tests is slightly elevated (±8.53%) due to the small sample size (10 iterations). This is expected for slow benchmarks.
