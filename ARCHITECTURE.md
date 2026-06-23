# Architecture & Tech Stack Decisions

**Last Updated:** 2026-06-23  
**Status:** Finalized ✅

---

## 🏗️ Architecture Overview

### High-Level Architecture Diagram
```
┌─────────────────────────────────────────────────────────────┐
│                     Mobile Application                      │
│                  (Native Android / Kotlin / Compose)        │
│                 (Runs on Android Emulator)                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                    HTTP/REST API
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                   Backend Services                          │
│                (TypeScript / Hono framework)                │
│         (Deployed on Cloudflare Workers)                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                        SQL/Bindings
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                      Database                               │
│                (Cloudflare D1 SQLite)                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 🛠️ Tech Stack (Finalized)

### Mobile Development
- **Framework:** Native Android (Jetpack Compose)
- **Language:** Kotlin
- **Build Tools:** Gradle (Kotlin DSL - `build.gradle.kts`)
- **Key Libraries:** Retrofit (network), Hilt (DI), Room (local cache), Coroutines (concurrency)
- **Rationale:** Native Android with Kotlin and Jetpack Compose provides peak performance, modern declarative UI building, smooth animations, and robust system-level integration.

### Backend Services
- **Runtime:** Cloudflare Workers
- **Language:** TypeScript
- **Framework:** Hono (ultra-fast web framework optimized for edge/Cloudflare Workers)
- **Deployment:** Cloudflare Workers (via Wrangler CLI)
- **Rationale:** TypeScript ensures static type safety. Hono provides an extremely lightweight, Express-like routing API designed specifically for the Cloudflare Workers edge runtime.

### Deployment Platform
- **Decision:** Cloudflare Workers ✅
- **Why:** Serverless, scales globally with zero-cold starts, low latency, and highly cost-effective.
- **Tool:** Wrangler CLI
- **Configuration:** wrangler.toml
- **Environment:** Development, Staging, Production

### Database
- **Decision:** Cloudflare D1 ✅
- **Why:** Cloudflare's native serverless SQLite-based SQL database. D1 resides at the edge alongside the Worker code, minimizing query latencies and offering straightforward database bindings without needing manual connection pools.
- **ORM/Querying:** Raw SQL queries / bindings for lightweight execution.

### CI/CD & Deployment
- **Decision:** GitHub Actions ✅
- **Triggers:** Every push, every PR
- **Checks:**
  - Code quality (ESLint, Prettier)
  - Type checking (TypeScript)
  - Android Gradle Lint & Build check
  - Unit tests for Backend and Mobile
- **Deployment:** Automatic wrangler deployment on merge to `main`

### Development Tools
- **Version Control:** Git + GitHub ✅
- **Package Manager:** `npm` (for backend)
- **Testing Framework:** Vitest (for backend TypeScript code), JUnit/Compose UI Test (for Android)
- **Linting:** ESLint & Prettier (backend), ktlint / Android Lint (mobile)

---

## 🔐 Security Considerations

- [ ] API Authentication (JWT / API Keys)
- [ ] HTTPS/TLS for all communication (enforced natively by Cloudflare)
- [ ] Environment variables for secrets (Wrangler secrets)
- [ ] Input validation & sanitization
- [ ] Rate limiting
- [ ] CORS configuration
- [ ] SQL injection prevention (using parameterized queries via D1 bindings)

---

## 📈 Scalability & Performance

### Edge Scalability
- Cloudflare Workers and D1 automatically scale globally on Cloudflare's edge.
- D1 handles read/write queries with minimal network hops.

### Mobile App Performance
- Jetpack Compose lazy layout components for list rendering.
- Offline-first cache architecture with Jetpack Room.
- Structured concurrency with Kotlin Coroutines.

---

## 🧪 Testing Strategy

### Backend Tests
- **Framework:** Vitest
- **Location:** `backend/tests/`
- Mocking D1 bindings locally using Miniflare/Wrangler's built-in testing system.

### Mobile Tests
- **Framework:** JUnit & Compose UI Test
- **Location:** `mobile/app/src/test/` and `mobile/app/src/androidTest/`

---

## 📦 Project Structure

```
project-root/
├── backend/               # Backend Cloudflare Worker
│   ├── src/               # Worker source code
│   │   └── index.ts       # Hono entry point
│   ├── tests/             # Backend test files
│   ├── wrangler.toml      # Wrangler configuration
│   └── package.json       # Dependencies
├── mobile/                # Native Android application
│   ├── app/               # Main application module
│   │   ├── src/           # Kotlin source code, layout, assets
│   │   └── build.gradle.kts # App dependencies and configs
│   ├── build.gradle.kts   # Root gradle config
│   └── settings.gradle.kts # Gradle settings
├── docs/                  # Documentation
├── .github/
│   └── workflows/         # GitHub Actions workflows
├── .gitignore
└── README.md
```

---

## 📋 Decision Log

### Decision 1: Deployment Platform
- **Date:** 2026-06-22
- **Choice:** Cloudflare Workers
- **Rationale:** Scalable, serverless, cost-effective, perfect for edge deployment
- **Status:** ✅ Finalized

### Decision 2: CI/CD Platform
- **Date:** 2026-06-22
- **Choice:** GitHub Actions
- **Rationale:** Native GitHub integration, easy to configure
- **Status:** ✅ Finalized

### Decision 3: Mobile Framework
- **Date:** 2026-06-23
- **Choice:** Native Android (Kotlin / Jetpack Compose)
- **Rationale:** Modern native development, high-performance UI components, standard Kotlin support
- **Status:** ✅ Finalized

### Decision 4: Backend Runtime & Library
- **Date:** 2026-06-23
- **Choice:** TypeScript + Hono Framework
- **Rationale:** Lightweight, standard worker routing, type safe
- **Status:** ✅ Finalized

### Decision 5: Database
- **Date:** 2026-06-23
- **Choice:** Cloudflare D1 (SQLite)
- **Rationale:** Native serverless SQLite on the edge, low latency, easy deployment
- **Status:** ✅ Finalized
