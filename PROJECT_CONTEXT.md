# Project Context & Overview

**Last Updated:** 2026-06-23  
**Session Status:** Project initialization phase

---

## 📋 Project Summary
**Project Name:** Crypto Pulse  
**Repository:** Local (GitHub setup pending connection)  
**Type:** Mobile Application & Serverless Backend  
**Primary Goal:** Build a professional, production-ready mobile crypto tracker app with modern Jetpack Compose, serverless backend (Cloudflare Workers + D1 database), automated CI/CD, and robust testing.

---

## 🎯 Core Features (Priority Order)
1. **Live Price Monitor**: Real-time cryptocurrency prices, search, and details powered by public APIs.
2. **Interactive Price Charts**: Historical performance tracking (24h, 7d, 30d, 1y).
3. **Portfolio Tracker**: User portfolio transaction log and balance tracker stored securely in Cloudflare D1.
4. **Price Watchlist & Alerts**: Customized watchlist with target price notifications.
5. **Crypto News Feed**: Real-time cryptocurrency news aggregator.

---

## 🛠️ Tech Stack

### Mobile
- **Framework:** Jetpack Compose (Modern native Android UI toolkit)
- **Language:** Kotlin
- **Build Tools:** Gradle (Kotlin DSL - `build.gradle.kts`)
- **Key Libraries:** Retrofit (network), Room (local cache), Hilt (dependency injection), Jetpack Navigation

### Backend
- **Runtime:** Node.js / Cloudflare Workers
- **Language:** TypeScript
- **Deployment:** Cloudflare Workers (via Wrangler CLI)
- **Key Libraries:** Hono (ultra-lightweight web framework for Workers), wrangler

### Database
- **Type:** SQL Database (Relational)
- **Provider:** Cloudflare D1 (Native serverless SQLite database for Cloudflare Workers)

### DevOps & CI/CD
- **Version Control:** GitHub
- **CI/CD:** GitHub Actions
- **Code Review Automation:** Custom linting/validation checks on Pull Requests
- **Deployment:** Automated deploy to Cloudflare Workers on merging to `main`

---

## 📍 Project Phases (10-Step Roadmap)

| Phase | Status | Description | Dependencies |
|-------|--------|-------------|--------------|
| 1 | ⏳ In Progress | Project initialization & Local structure | — |
| 2 | ⏳ Pending | CI/CD workflow with automated code review | Phase 1 |
| 3 | ⏳ Pending | Backend services & D1 database schema | Phase 2 |
| 4 | ⏳ Pending | Wrangler CLI integration & deployment | Phase 3 |
| 5 | ⏳ Pending | Validate backend deployment automation | Phase 4 |
| 6 | ⏳ Pending | UI/UX Design & Implementation | Phase 5 |
| 7 | ⏳ Pending | Mobile app ↔ Backend integration | Phase 6 |
| 8 | ⏳ Pending | Android emulator setup & E2E testing | Phase 7 |
| 9 | ⏳ Pending | Bug fixes & performance optimization | Phase 8 |
| 10 | ⏳ Pending | Production polish & final deployment | Phase 9 |

---

## 🔄 Development Workflow

### Each Phase Follows:
1. ✅ Requirements definition
2. ✅ Code implementation
3. ✅ Automated code review (via GitHub Actions)
4. ✅ Manual review & feedback
5. ✅ Testing & validation
6. ✅ Deployment (if applicable)
7. ✅ Documentation update

### Quality Checks (Automated):
- Code quality analysis
- Code clarity review
- Architecture validation
- Business logic verification
- Linting & formatting
- Test coverage
- Security scanning

---

## 📁 Repository Structure
See **PROJECT_STRUCTURE.md** for detailed folder layout

---

## 🔑 Key Decisions & Architecture
See **ARCHITECTURE.md** for tech stack rationale and architectural decisions

---

## 📊 Progress Tracking
See **PROGRESS.md** for detailed task breakdown and status

---

## 📝 Quick Start for Future Sessions
1. Open this folder in VS Code / Android Studio
2. Check **PROGRESS.md** to see what was completed and what's pending
3. Review the last task in PROGRESS.md to understand current context
4. Check **ARCHITECTURE.md** for tech stack and design decisions
5. Continue from the next pending task

---

## 💡 Important Notes
- All code follows the established patterns and conventions
- Every push triggers automated workflows
- Backend deployment is fully automated
- Each phase is independent but builds on previous ones
- Testing happens at each phase, not just at the end

---

## 🚀 Next Steps
1. Finalize the backend/mobile basic folder structure initialization
2. Set up GitHub Actions workflow (`ci-cd.yml`)
3. Develop initial backend and database schema configurations
