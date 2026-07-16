# GitHub Actions CI/CD Pipeline

> Professional, production-grade automated quality assurance for Crypto Pulse

---

## 🚀 Quick Overview

This directory contains **four GitHub Actions workflows** that automate:

- ✅ **Code Quality Checks** (linting, types)
- ✅ **Automated Testing** (unit tests)
- ✅ **Security Scanning** (dependency review, CodeQL)
- ✅ **Build Validation** (compilation, APK artifacts)
- ✅ **Deployment Automation** (Wrangler → Cloudflare Workers)
- ✅ **Post-Deploy QA** (backend validation, E2E tests)

Every code change is automatically validated before it reaches production.

---

## 📂 Files in This Directory

### **Workflows** (`.github/workflows/`)
```
├── deploy.yml          Deployment pipeline - builds, tests, migrates D1, deploys Worker
├── mobile-pr.yml       Mobile PR checks - Android tests, lint, debug APK build
├── qa.yml              Post-deploy QA - backend validation + Maestro E2E tests
└── security.yml        Security scanning - CodeQL + dependency review
```

### **Documentation**
```
├── README.md           This file
├── D1_TOKEN_REQUIREMENTS.md   Cloudflare D1 auth requirements
└── WRANGLER_EXECUTION_PLAN.md Wrangler CLI integration guide
```

---

## 🎯 Workflow System

### 1️⃣ **deploy.yml** - Backend Deployment
**When:** Push to `main` or `workflow_dispatch`  
**What:** Lint → Type Check → Test → Build → D1 Migrations → Deploy Worker → Smoke Test  
**Duration:** 5-10 minutes  
**Result:** Worker live at production URL

### 2️⃣ **mobile-pr.yml** - Mobile PR Checks
**When:** Push/PR to `main` touching `mobile/**`  
**What:** Unit Tests → Lint → Debug APK Build  
**Duration:** 10-15 minutes  
**Result:** ✅ PASS or ❌ FAIL (blocks merge if fail)

### 3️⃣ **qa.yml** - Post-Deploy QA
**When:** After `deploy.yml` completes successfully on `main`  
**What:** Backend QA validation → Build Android APK → Maestro E2E tests  
**Duration:** 15-20 minutes  
**Result:** Consolidated QA report + artifacts

### 4️⃣ **security.yml** - Security Scanning
**When:** Push/PR to `main` + weekly schedule  
**What:** Dependency Review → CodeQL (backend + mobile)  
**Duration:** 10-15 minutes  
**Result:** Security findings in GitHub Security tab

---

## ✅ Quality Gates (What Must Pass)

| Check | Requirement | Blocks Merge |
|-------|-------------|--------------|
| **Lint** | ESLint | ✅ Yes |
| **Type Check** | TypeScript compiler | ✅ Yes |
| **Unit Tests** | All tests pass | ✅ Yes |
| **Build** | Compilation succeeds | ✅ Yes |
| **Security** | No critical vulns | ✅ Yes |
| **Deploy** | Worker deploys + health check | ✅ Yes |
| **QA** | Backend + E2E validation | ✅ Yes |

---

## 🔧 How to Use

### **Run Checks Locally Before Pushing**
```bash
cd backend
npm run lint          # Check code style
npm run type-check    # Check TypeScript types
npm run test          # Run tests
npm run build         # Verify build

cd mobile
./gradlew test        # Android unit tests
./gradlew lint        # Android lint
./gradlew assembleDebug  # Build debug APK
```

### **Typical Development Flow**
```
1. Create feature branch
2. Write code locally
3. Run checks locally
4. Push to GitHub
5. GitHub automatically runs workflows
6. If ❌ fails: Fix locally, push again
7. If ✅ passes: Create PR, request review
8. Get approval → Merge to main
9. Auto-deploy to production + QA
```

---

## 🔐 Setup Requirements

Before workflows can run, you need:

### **1. GitHub Secrets**
Go to GitHub repo Settings → Secrets and Variables → Actions

Add these:
```
CLOUDFLARE_WORKERS_API_TOKEN   # Cloudflare API token with Workers + D1 permissions
JWT_SECRET                     # JWT signing secret
ENCRYPTION_KEY                 # Encryption key for sensitive data
RESEND_API_KEY                 # Email service API key
ALLOWED_ORIGINS                # CORS allowed origins
FCM_SERVER_KEY                 # Firebase Cloud Messaging server key
QA_EXCHANGE_NAME               # QA exchange name
QA_EXCHANGE_API_KEY            # QA exchange API key
QA_EXCHANGE_API_SECRET         # QA exchange API secret
QA_EXCHANGE_ENVIRONMENT        # QA exchange environment
```

### **2. Cloudflare Configuration**
- `backend/wrangler.toml` must have `account_id` pinned
- D1 database `crypto_pulse_db` must exist
- Worker `crypto-pulse-backend` must be deployed

---

## 📊 Workflow Performance

| Workflow | Duration | Parallelization |
|----------|----------|-----------------|
| **deploy.yml** | 5-10 min | Sequential (dependent steps) |
| **mobile-pr.yml** | 10-15 min | Parallel jobs |
| **qa.yml** | 15-20 min | Sequential (dependent jobs) |
| **security.yml** | 10-15 min | Parallel jobs |

All jobs run in parallel where possible to minimize total time.

---

## 📈 What Gets Tracked

- 📊 **Test Results** - Stored as artifacts
- 📊 **Build Artifacts** - APK, reports
- 📊 **Security Findings** - GitHub Security tab
- 📊 **Deployment Logs** - Stored in Actions history
- 📊 **QA Reports** - JSON + Markdown summaries

---

## ❌ Troubleshooting

### **Deploy Failed?**
- Check `CLOUDFLARE_WORKERS_API_TOKEN` is configured in GitHub Secrets
- Verify Cloudflare account has Workers + D1 enabled
- Check deployment logs in GitHub Actions

### **Mobile Build Failed?**
- Verify Java 17 is available
- Check Android SDK setup
- Review Gradle logs in artifacts

### **QA Failed?**
- Check backend is deployed and healthy
- Verify QA secrets are configured
- Review Maestro screenshots in artifacts

### **Security Scan Found Issues?**
- Review findings in GitHub Security tab
- Update vulnerable packages: `npm update` or `./gradlew dependencyUpdates`
- If intentional, add to suppressions

---

## 📚 Additional Documentation

- **D1_TOKEN_REQUIREMENTS.md** - Cloudflare D1 auth setup
- **WRANGLER_EXECUTION_PLAN.md** - Wrangler CLI integration guide

---

**Created:** 2026-06-23  
**Last Updated:** 2026-07-16  
**Status:** ✅ Active and Maintained  
**Framework:** GitHub Actions
