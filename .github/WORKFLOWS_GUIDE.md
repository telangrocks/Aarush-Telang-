# GitHub Actions CI/CD Workflows - Complete Guide

**Last Updated:** 2026-06-23  
**Status:** Ready for Implementation

---

## 📋 Overview

This document explains the professional GitHub Actions CI/CD pipeline for **Crypto Pulse**. The workflow acts as an automated quality engineer, validating every change before production deployment.

### Pipeline Workflow

```
Developer Push/PR
       ↓
GitHub Actions Triggered
       ↓
   ┌─────────────────────────────────────────┐
   │  1. Lint & Code Quality (parallel)      │
   │  2. Type Checking (parallel)            │
   │  3. Unit Tests & Coverage (parallel)    │
   │  4. Integration Tests (sequential)      │
   │  5. Security Scanning (parallel)        │
   │  6. Build Validation (parallel)         │
   └──────────────┬──────────────────────────┘
                  ↓
         ┌─────────────────┐
         │  Pass All? ✅   │
         └────────┬────────┘
                  │
       ┌──────────┴──────────┐
       ↓                     ↓
     YES                    NO
       ↓                     ↓
  Merge OK          Fix Issues & Retry
       ↓
   Auto-Deploy (if on main/staging)
```

---

## 🔧 Workflow Files

### 1. **ci.yml** - Continuous Integration
**Triggered on:** Push to `main`, `develop`, `staging` + all PRs

**Jobs:**
- ✅ **Lint & Code Quality** - ESLint, Prettier formatting
- ✅ **Type Checking** - TypeScript validation
- ✅ **Unit Tests & Coverage** - Jest/Vitest with coverage reports
- ✅ **Integration Tests** - API + DB integration tests
- ✅ **Security Scanning** - Trivy vulnerability scan
- ✅ **Build Validation** - Compilation & artifact generation
- ✅ **Final Status** - Summary & pass/fail determination

**Output:**
- Lint reports (artifacts)
- Coverage reports (uploaded to Codecov)
- Build artifacts (dist/)
- Security scan results

---

### 2. **deploy.yml** - Deployment Pipeline
**Triggered on:** Push to `main` (production) or `staging`

**Jobs:**
- ✅ **Pre-Deploy Checks** - Verify secrets, determine target environment
- ✅ **Deploy Backend** - Wrangler CLI deploy to Cloudflare Workers
- ✅ **Verify Deployment** - Health checks on deployed service
- ✅ **Notify** - Slack notifications (optional)

**Environments:**
- `staging` - Test environment (no user data)
- `production` - Live environment (encrypted secrets only)

**Output:**
- Deployment logs (artifacts)
- Health check results

---

### 3. **security.yml** - Security & Dependency Scanning
**Triggered on:** Push/PR + Daily schedule at 2 AM UTC

**Jobs:**
- ✅ **Snyk Scan** - Vulnerability detection
- ✅ **OWASP Dependency Check** - Known vulnerable dependencies
- ✅ **npm Audit** - Node.js package vulnerabilities
- ✅ **Secret Scanning** - Detects leaked credentials
- ✅ **License Compliance** - Ensures approved licenses only
- ✅ **SAST Analysis** - CodeQL for code security
- ✅ **Container Security** - Trivy for Docker images (if used)

**Output:**
- Vulnerability reports (artifacts)
- Security findings (GitHub Security tab)
- License compliance report

---

## 📊 What Each Job Does

### **Lint & Code Quality** 
**Purpose:** Catch style issues, formatting inconsistencies

**Checks:**
- ESLint rules (unused vars, potential bugs, best practices)
- Prettier formatting (indentation, quotes, line length)
- Code style consistency

**Fail If:**
- ESLint errors found (fixable with `npm run lint:fix`)
- Prettier formatting issues (auto-fixable with `npm run format`)

**Fix Locally:**
```bash
cd backend  # or mobile
npm run lint:fix      # Auto-fix ESLint issues
npm run format        # Auto-format with Prettier
```

---

### **Type Checking**
**Purpose:** Catch TypeScript type errors before runtime

**Checks:**
- Type mismatches
- Missing type definitions
- Incorrect function signatures
- Unsafe any types

**Fail If:**
- TypeScript compilation errors

**Fix Locally:**
```bash
cd backend
npm run type-check    # Or: npx tsc --noEmit
```

---

### **Unit Tests & Coverage**
**Purpose:** Ensure code logic is correct and tested

**Checks:**
- Test suite passes
- Code coverage >80% (configurable)
- No failing assertions

**Fail If:**
- Tests don't pass
- Coverage drops below threshold

**Fix Locally:**
```bash
cd backend
npm run test          # Run tests
npm run test -- --coverage    # With coverage report
```

---

### **Integration Tests**
**Purpose:** Test API endpoints, database interactions, third-party integrations

**Checks:**
- API routes respond correctly
- Database queries work
- Auth flows work end-to-end

**Dependencies:**
- PostgreSQL database (spun up in Docker)
- Environment variables configured

**Fail If:**
- Integration test fails
- API returns unexpected status codes

**Fix Locally:**
```bash
cd backend
npm run test:integration     # Requires local DB setup
```

---

### **Security Scanning** 
**Purpose:** Detect vulnerabilities in dependencies, code, secrets

**Checks:**
- Known CVEs in npm packages
- Hardcoded secrets (API keys, tokens, passwords)
- Vulnerable dependency versions
- Code security issues

**Fail If:**
- Critical vulnerabilities found
- Secrets detected in code

**Fix:**
- Update vulnerable packages: `npm update`
- Remove hardcoded secrets, use environment variables
- Rotate compromised credentials

---

### **Build Validation**
**Purpose:** Ensure code compiles and produces valid artifacts

**Checks:**
- TypeScript compilation succeeds
- Build process completes
- Build output exists (dist/, build/)
- No minification errors

**Fail If:**
- Build command fails
- No output generated

**Fix Locally:**
```bash
cd backend
npm run build      # Should create dist/
```

---

### **Final Status Check**
**Purpose:** Summarize all job results and determine overall pass/fail

**Shows:**
- Pass/fail for each job
- Failed job count
- Recommendation: "Fix X issues before merge"

---

## 🚀 How to Use This Pipeline

### **As a Developer**

#### When you push code:
1. GitHub automatically runs CI workflow
2. Check "Actions" tab in GitHub to see progress
3. Wait for all checks to complete (5-15 min typically)
4. Fix any failing checks locally
5. Push fixes → CI runs again
6. Once all pass, you can merge/deploy

#### Before pushing:
```bash
# Run all checks locally (recommended)
npm run lint          # Check code style
npm run type-check    # Check TypeScript types
npm run test          # Run unit tests
npm run build         # Verify build works

# Fix issues automatically where possible
npm run lint:fix      # Auto-fix linting
npm run format        # Auto-format code
```

#### If a check fails in CI:
1. Read the error message in the workflow logs
2. Run the same check locally to reproduce
3. Fix the issue
4. Commit and push again
5. CI will automatically re-run

---

### **CI/CD Quality Gates**

| Check | Required | Impact | Action |
|-------|----------|--------|--------|
| Lint | Yes | Blocks merge | Fix styles, use lint:fix |
| Type Check | Yes | Blocks merge | Fix TypeScript errors |
| Unit Tests | Yes | Blocks merge | Fix test failures |
| Build | Yes | Blocks merge | Debug build errors |
| Security | Yes | Blocks merge | Update dependencies, remove secrets |
| Integration Tests | Yes | Blocks merge | Debug API/DB issues |

---

## 🔐 Security & Secrets Management

### Required GitHub Secrets (Configure in Settings)

```
WRANGLER_API_TOKEN           # For Cloudflare Workers deployment
STAGING_DATABASE_URL         # Staging database connection
PRODUCTION_DATABASE_URL      # Production database (ENCRYPTED)
SLACK_WEBHOOK                # Optional: Slack notifications
SNYK_TOKEN                   # Optional: Snyk vulnerability scanning
GITGUARDIAN_API_KEY          # Optional: Secret detection
```

### ⚠️ Never Commit Secrets
- Use `.env.example` (no secrets)
- Add `.env.local` to `.gitignore`
- All secrets go through GitHub Secrets
- Pipeline injects them at runtime

---

## 📈 Metrics & Monitoring

### Available Metrics:
- **Test Coverage** - Reported to Codecov
- **Build Time** - Logged per job
- **Security Vulnerabilities** - Reported in GitHub Security tab
- **Dependency Updates** - Tracked via Dependabot

### View Results:
1. **Actions Tab** - Live workflow status
2. **Security Tab** - Vulnerability alerts
3. **Codecov** - Coverage trends
4. **Artifacts** - Download reports

---

## 🔄 Branching Strategy with CI/CD

### Branch Protection Rules (To Configure)

**On `main` branch:**
- Require PR review (1+ approvals)
- Require CI to pass before merge
- Require up-to-date before merge
- Dismiss stale reviews
- Require status checks to pass

**On `develop` branch:**
- Require CI to pass before merge
- Allow force push (for history rewriting)

**On `staging` branch:**
- Auto-deploy on push (no manual approval needed)
- Require CI to pass

---

### Workflow

```
Feature Development:
1. Create branch: git checkout -b feature/my-feature
2. Write code + tests
3. Push: git push origin feature/my-feature
4. CI runs automatically
5. Fix any CI failures locally
6. Create PR → CI runs again
7. Get review approval
8. Merge to develop
9. CI runs on develop → auto-deploys to staging

Release:
1. Merge develop → main
2. CI runs on main
3. If all pass → manually trigger deploy
4. Deployed to production

Hotfix:
1. Branch from main: git checkout -b hotfix/bug-fix
2. Fix + test locally
3. Push + CI validation
4. Create PR, merge to main
5. Auto-deploy to production
```

---

## 🛠️ Configuration Files

### Backend (`backend/`)
- `package.json` - Dependencies, scripts
- `tsconfig.json` - TypeScript config
- `.eslintrc.json` - ESLint rules
- `.prettierrc` - Prettier config
- `jest.config.js` - Test config (if using Jest)
- `wrangler.toml` - Cloudflare Workers config

### Mobile (`mobile/`)
- `package.json` - Dependencies, scripts
- `tsconfig.json` - TypeScript config
- `.eslintrc.json` - ESLint rules
- `jest.config.js` - Test config (if using Jest)

### Root (`.github/workflows/`)
- `ci.yml` - This CI pipeline
- `deploy.yml` - Deployment pipeline
- `security.yml` - Security scanning

---

## 📊 Expected CI Duration

| Workflow | Typical Time |
|----------|-------------|
| Lint & Type Check | 2-3 min |
| Unit Tests | 3-5 min |
| Integration Tests | 5-10 min |
| Security Scan | 3-5 min |
| Build Validation | 2-3 min |
| **Total (all parallel)** | **10-15 min** |

---

## ❌ Troubleshooting

### "Workflow failed at linting step"
**Solution:** Run `npm run lint:fix && npm run format` locally

### "Type checking failed"
**Solution:** Run `npm run type-check` and fix TypeScript errors

### "Tests failed"
**Solution:** Run `npm test` locally to reproduce, debug and fix

### "Build failed"
**Solution:** Run `npm run build` locally, check error messages

### "Deployment failed"
**Solution:** Check `WRANGLER_API_TOKEN` is set in GitHub Secrets

### "Security scan found vulnerabilities"
**Solution:** Run `npm audit`, update packages, or add suppressions

---

## ✅ Pre-Merge Checklist

Before submitting a PR, ensure:
- [ ] All CI checks pass (green checkmarks)
- [ ] Test coverage meets requirements
- [ ] No security vulnerabilities introduced
- [ ] No secrets committed
- [ ] Build completes successfully
- [ ] Code is formatted (lint:fix)
- [ ] Type checking passes
- [ ] PR has clear description
- [ ] PR is linked to issue (if applicable)

---

## 🚀 Next Steps

1. **Initialize project locally** with git
2. **Create `backend/` and `mobile/` with package.json files**
3. **Push to GitHub** and verify workflows trigger
4. **Fix any initial failures** (missing scripts, config files)
5. **Configure GitHub Secrets** (Wrangler token, DB URLs)
6. **Enable branch protection rules** on main
7. **Start feature development** with confidence

---

## 📚 Related Files
- `PROJECT_STRUCTURE.md` - Directory layout
- `ARCHITECTURE.md` - Tech stack decisions
- `.gitignore` - Files excluded from git
- Individual workflow files in `.github/workflows/`

---

**Questions?** Refer to the individual workflow files for detailed comments on each step.
