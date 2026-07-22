# AI-Driven Feature Production Readiness Workflow Framework

## Overview

This document defines the mandatory execution workflow for preparing any feature for production. The AI operates as an end-to-end inspector, improver, and validator. The process is strictly sequential and repetition-based until production readiness is confirmed.

**Execution Contract:**
- The AI MUST start with existing repository state. No assumptions.
- The AI MUST use repository-defined MCP configuration and references.
- The AI MUST NOT skip phases.
- The AI MUST repeat the verification loop until all gates pass.

---

## Phase 1: Backend Discovery & Schema Understanding

**Objective:** Fully understand the server-side ecosystem before touching the client.

**Actions:**
1. Inspect repository MCP setup, configuration files, and references.
2. Scan from cloud/server/backend side outward.
3. Analyze:
   - Database schemas and migrations
   - Backend architecture (services, modules, layers)
   - Workers, queues, cron jobs, and server-side processes
   - API endpoints, contracts, and data shapes
   - Data flow, event pipelines, and related backend components

**Outputs:**
- Backend component inventory
- API/data contract summary
- Data origin and storage map

**Gate:** Backend map is complete and documented before proceeding.

---

## Phase 2: Official Android Flow Mapping

**Objective:** Trace the feature through the existing Android codebase using official architecture.

**Actions:**
1. Move into the Android application through the repo-defined codebase flow.
2. Follow existing architecture, navigation, and module patterns.
3. Trace the feature journey until reaching:
   - UI layer
   - UX implementation
   - Screens and components
   - User interaction flows

**Outputs:**
- End-to-end journey trace: `Backend Server → API/Data Flow → Android Logic → UI Layer → UX Experience`

**Gate:** Complete Android flow map exists before proceeding.

---

## Phase 3: Complete Workflow Understanding

**Objective:** Map the entire lifecycle of the feature data.

**Actions:**
1. Document where data originates.
2. Document how data moves through the backend.
3. Document how workers/processes handle it.
4. Document how APIs expose it.
5. Document how Android consumes it.
6. Document how the UI presents it.
7. Document how the user interacts with it.

**Outputs:**
- End-to-end workflow diagram or trace
- Ownership map (backend/Android/UI responsibility per step)

**Gate:** Full lifecycle map is verified against the repository.

---

## Phase 4: Feature Gap Detection

**Objective:** Identify missing, incomplete, or broken parts without making changes.

**Actions:**
1. Compare existing implementation against the complete workflow map.
2. Check:
   - Existing vs. missing backend requirements
   - Existing vs. missing Android implementation
   - Existing vs. missing UI/UX requirements
   - Existing vs. missing edge-case handling
   - Existing vs. missing production requirements (error handling, logging, monitoring, auth, performance, security, offline behavior)

**Outputs:**
- Gap list with severity and affected layer

**Gate:** All gaps are explicitly listed with clear ownership before execution begins.

---

## Phase 5: Production Readiness Execution

**Objective:** Close gaps systematically without breaking verified flows.

**Actions per gap:**
1. Identify the gap and its root cause.
2. Implement or fix the required changes.
3. Re-check the complete workflow for side effects.
4. Validate backend-to-Android-to-UI flow again.
5. Verify whether the feature satisfies production requirements.

**Rules:**
- Fix one gap at a time when possible.
- Re-validate immediately after each change.
- Do not alter behavior outside the gap scope.

**Outputs:**
- Implementation diff per gap
- Re-validation result per gap

**Gate:** Gap is closed and re-validation passes before moving to the next gap.

---

## Phase 6: Repeated Verification Loop

**Objective:** Guarantee production readiness through continuous re-checking.

**Loop Cycle:**
```
Analyze → Identify Gap → Improve → Recheck → Validate
```

**Termination Criteria:**
- Backend flow is verified.
- Android flow is verified.
- UI/UX flow is verified.
- Feature behavior is complete.
- Production readiness confirmation is achieved.

**Actions:**
- Run the full loop after every change set.
- If a gate fails, return to the relevant phase and re-analyze.
- Only exit the loop when all termination criteria are satisfied.

---

## End-to-End Execution Path

```
Cloud Backend
    ↓
Database Schema
    ↓
Workers / Processes
    ↓
APIs / Data Contracts
    ↓
Android Application
    ↓
UI / UX
    ↓
Feature Validation
    ↓
Production Readiness (Loop Until Confirmed)
```

## Usage Notes

- Treat this workflow as a mandatory controller, not a suggestion.
- Each phase must be executed in order.
- Phase 6 loops back to the relevant earlier phase when failures are found.
- All outputs must be traceable to repository artifacts.
- External logic or assumptions are forbidden unless derived from repository state.

---

## Exchange Layer Architecture Guidelines

To maintain scalability across exchanges and market types:
1. **Spot Markets**: Use the exchange-provided `minOrderAmt` (or equivalent quote order floor).
2. **Linear / Futures Markets**: Use `minNotionalValue` or the exchange's documented minimum order rule. Only derive from `minOrderQty × livePrice` if the exchange does not expose a direct quote minimum.
3. **Adapter Isolation**: Keep each exchange adapter (Bybit, Binance, Delta, OKX) market-aware so symbol metadata rules do not bleed across market types or UI components.

