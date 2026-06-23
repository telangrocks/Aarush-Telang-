# Wrangler CLI Integration Guide

**Focus:** Two Critical Integrations  
**Scope:** Infrastructure Layer ONLY (No Application Features)  
**Stack:** Cloudflare Services EXCLUSIVELY  
**Status:** Starting Implementation

---

## 🎯 Two Integration Objectives

### **Integration 1: Wrangler CLI ↔ Local Development Environment**
- Install Wrangler CLI globally on your machine
- Create Cloudflare Workers project structure
- Verify local development server
- Test with mock API endpoints

### **Integration 2: Wrangler CLI ↔ Cloudflare Account**
- Authenticate Wrangler with your Cloudflare account
- Connect to Cloudflare API
- Verify account access and permissions
- Test deployment to Cloudflare

---

## 📊 Cloudflare Ecosystem (Backend Stack Only)

You will use ONLY Cloudflare services for the entire backend:

```
┌─────────────────────────────────────────────────────────────┐
│              CLOUDFLARE SERVICES (Complete Stack)           │
│                                                             │
│  Compute Layer:                                             │
│  ├─ Cloudflare Workers (API endpoints)                      │
│  └─ Durable Objects (stateful compute, if needed)          │
│                                                             │
│  Storage Layer:                                             │
│  ├─ Cloudflare D1 (SQLite database)                        │
│  └─ Cloudflare KV (key-value cache)                        │
│                                                             │
│  Security Layer:                                            │
│  ├─ Cloudflare Authentication / OAuth                      │
│  ├─ Encrypted environment variables                        │
│  └─ API rate limiting & DDoS protection                    │
│                                                             │
│  Integration Layer:                                         │
│  ├─ Triggers (scheduled, HTTP)                             │
│  └─ Service Bindings (inter-worker communication)          │
│                                                             │
│  Wrangler CLI (Management Tool):                            │
│  ├─ Project scaffolding                                     │
│  ├─ Local development                                       │
│  ├─ Deployment automation                                  │
│  └─ Environment management                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔄 Linear Implementation Path

```
STEP 1: Install Wrangler CLI
        ↓
STEP 2: Authenticate with Cloudflare
        ↓
STEP 3: Verify Local Environment (npm)
        ↓
STEP 4: Create Wrangler Project
        ↓
STEP 5: Configure wrangler.toml
        ↓
STEP 6: Test Local Development Server
        ↓
STEP 7: Deploy Test to Cloudflare
        ↓
STEP 8: Verify Production Endpoint
        ↓
BOTH INTEGRATIONS COMPLETE ✅
```

---

## 📝 STEP-BY-STEP IMPLEMENTATION

### **STEP 1: Install Wrangler CLI Globally**

**Command:**
```bash
npm install -g wrangler
```

**Verification:**
```bash
wrangler --version
# Expected output: wrangler X.XX.X
```

**Location:** Wrangler installed in global npm packages  
**Time:** 2-3 minutes

---

### **STEP 2: Authenticate Wrangler with Cloudflare**

**Command:**
```bash
wrangler login
```

**What happens:**
1. Browser opens to Cloudflare login page
2. You authorize Wrangler to access your account
3. Cloudflare generates API token
4. Token saved locally in `~/.wrangler/config.toml`

**Verification:**
```bash
wrangler status
# Expected output: Shows your Cloudflare account email
```

**Security Note:** 
- Token stored locally with restricted permissions
- Only Wrangler CLI can read it
- You can revoke at any time in Cloudflare dashboard

**Time:** 2-3 minutes (includes browser interaction)

---

### **STEP 3: Verify Local Node.js Environment**

**Commands:**
```bash
node --version
# Expected: v18+ (v20 recommended)

npm --version
# Expected: v9+

npm list -g wrangler
# Expected: Shows installed wrangler version
```

**If Node.js is missing:**
- Download from nodejs.org (LTS version)
- Install and restart terminal

**Time:** 1 minute

---

### **STEP 4: Create Wrangler Project Structure**

**Location:** Inside `/backend` directory

**Commands:**
```bash
cd "c:\Crypto Pulse ( New)\backend"

wrangler init
```

**Interactive Prompts:**
```
✔ What would you like to start with? › Basic worker
✔ Create a git repository? … no
✔ Type: TypeScript
✔ Test your TypeScript worker: yes
```

**Files Created:**
```
backend/
├── wrangler.toml              ← Configuration
├── src/
│   ├── index.ts              ← Main worker code
│   └── index.test.ts         ← Unit tests
├── tsconfig.json             ← TypeScript config
├── package.json              ← Dependencies
├── package-lock.json         ← Lock file
├── .gitignore                ← Git ignore
└── README.md                 ← Documentation
```

**Time:** 2-3 minutes

---

### **STEP 5: Configure wrangler.toml**

**File Location:** `backend/wrangler.toml`

**Current Content (from wrangler init):**
```toml
name = "crypto-pulse-backend"
main = "src/index.ts"
compatibility_date = "2026-06-23"

[env.production]
```

**Update to:**
```toml
# ============================================
# WRANGLER CONFIGURATION
# ============================================

name = "crypto-pulse-backend"
type = "javascript"
main = "src/index.ts"
compatibility_date = "2026-06-23"

# Node.js compatibility
compatibility_flags = ["nodejs_compat"]

# TypeScript configuration
[build]
command = "npm run build"
cwd = "./backend"
watch_paths = ["src/**/*.ts"]

# ============================================
# DEVELOPMENT ENVIRONMENT
# ============================================
[env.development]
name = "crypto-pulse-api-dev"
routes = [
  { pattern = "localhost:8787/*", zone_id = "dev" }
]

vars = { ENVIRONMENT = "development", LOG_LEVEL = "debug" }

# KV storage for development
kv_namespaces = [
  { binding = "KV_STORE", id = "dev-kv" }
]

# ============================================
# STAGING ENVIRONMENT
# ============================================
[env.staging]
name = "crypto-pulse-api-staging"

routes = [
  { pattern = "staging.cryptopulse.workers.dev/*", zone_id = "staging" }
]

vars = { ENVIRONMENT = "staging", LOG_LEVEL = "info" }

kv_namespaces = [
  { binding = "KV_STORE", id = "staging-kv" }
]

# D1 database binding
[[d1_databases]]
binding = "DB"
database_name = "crypto-pulse-staging"
database_id = "staging-db-id"

# ============================================
# PRODUCTION ENVIRONMENT
# ============================================
[env.production]
name = "crypto-pulse-api"

routes = [
  { pattern = "api.cryptopulse.workers.dev/*", zone_id = "prod" }
]

vars = { ENVIRONMENT = "production", LOG_LEVEL = "warn" }

kv_namespaces = [
  { binding = "KV_STORE", id = "prod-kv" }
]

# D1 database binding
[[d1_databases]]
binding = "DB"
database_name = "crypto-pulse-production"
database_id = "prod-db-id"
```

**Key Sections:**
- **Environments:** development (local), staging (test), production (live)
- **Bindings:** KV (cache), D1 (database), Durable Objects (state)
- **Routes:** URLs where workers are deployed

**Time:** 5 minutes

---

### **STEP 6: Create Basic Worker Entry Point**

**File:** `backend/src/index.ts`

**Replace default content with:**

```typescript
/**
 * CryptoPulse API - Main Entry Point
 * Cloudflare Workers Backend
 */

export default {
  async fetch(
    request: Request,
    env: any,
    ctx: any
  ): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // ==========================================
    // HEALTH CHECK ENDPOINT
    // ==========================================
    if (pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'CryptoPulse API',
          version: '1.0.0',
          environment: env.ENVIRONMENT,
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // ==========================================
    // API VERSION ENDPOINT
    // ==========================================
    if (pathname === '/api/info') {
      return new Response(
        JSON.stringify({
          name: 'CryptoPulse Trading Bot API',
          version: '1.0.0',
          endpoints: [
            { path: '/health', method: 'GET', description: 'Health check' },
            { path: '/api/info', method: 'GET', description: 'API information' },
            { path: '/api/v1/market', method: 'GET', description: 'Market data' },
            { path: '/api/v1/trading', method: 'GET/POST', description: 'Trading pairs' },
            { path: '/api/v1/signals', method: 'GET', description: 'Trade signals' },
          ],
          documentation: 'https://github.com/telangrocks/Aarush-Telang-/wiki',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // ==========================================
    // 404 - NOT FOUND
    // ==========================================
    return new Response(
      JSON.stringify({
        error: 'Not Found',
        message: `Endpoint '${pathname}' not found`,
        suggestions: [
          'Try /health for health check',
          'Try /api/info for API information',
        ],
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  },
};
```

**What this does:**
- `/health` - Health check endpoint (for monitoring)
- `/api/info` - API information endpoint (for documentation)
- Proper error handling (404 responses)
- Environment awareness (dev/staging/prod)

**Time:** 5 minutes

---

### **STEP 7: Install Dependencies & Build**

**Commands:**
```bash
cd backend

# Install dependencies
npm install

# Build the project
npm run build
```

**Expected Output:**
```
added X packages
npm notice created a lockfile
> npm run build
Successfully compiled TypeScript
Output written to dist/
```

**Time:** 2-3 minutes

---

### **STEP 8: Test Local Development Server**

**Command:**
```bash
npm run dev
```

**Expected Output:**
```
⛅ wrangler (version X.XX.X)
✨ Using TypeScript
✨ Bundling...
✨ Compiled successfully
⛅ Running on http://localhost:8787
```

**Test Endpoints (in new terminal):**

**Test 1: Health Check**
```bash
curl http://localhost:8787/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "service": "CryptoPulse API",
  "version": "1.0.0",
  "environment": "development",
  "timestamp": "2026-06-23T12:14:00.000Z"
}
```

**Test 2: API Info**
```bash
curl http://localhost:8787/api/info
```

**Expected Response:**
```json
{
  "name": "CryptoPulse Trading Bot API",
  "version": "1.0.0",
  "endpoints": [...]
}
```

**Test 3: 404 Error**
```bash
curl http://localhost:8787/nonexistent
```

**Expected Response:**
```json
{
  "error": "Not Found",
  "message": "Endpoint '/nonexistent' not found",
  "suggestions": [...]
}
```

**Time:** 5 minutes

---

### **STEP 9: Deploy Test to Cloudflare**

**Important:** Before deploying, create resources in Cloudflare account

**Create KV Namespace (for caching):**
```bash
wrangler kv:namespace create "KV_STORE"
wrangler kv:namespace create "KV_STORE" --preview
```

**Create D1 Database (for data storage):**
```bash
wrangler d1 create crypto-pulse-staging
wrangler d1 create crypto-pulse-production
```

**Update wrangler.toml** with returned IDs

**Deploy to Staging:**
```bash
wrangler deploy --env staging
```

**Expected Output:**
```
✨ Compiled successfully
✨ Published your Worker to
https://crypto-pulse-api-staging.telangrocks.workers.dev
```

**Deploy to Production:**
```bash
wrangler deploy --env production
```

**Test Production Endpoint:**
```bash
curl https://crypto-pulse-api.telangrocks.workers.dev/health
```

**Time:** 10-15 minutes

---

## ✅ Integration Verification Checklist

### **Integration 1: Wrangler CLI ↔ Local Development**

- [ ] Wrangler installed globally (`wrangler --version`)
- [ ] Project created in `/backend` directory
- [ ] `wrangler.toml` configured with all environments
- [ ] `src/index.ts` implements required endpoints
- [ ] Dependencies installed (`npm install` successful)
- [ ] Local dev server starts (`npm run dev`)
- [ ] Health endpoint responds (`curl http://localhost:8787/health`)
- [ ] API info endpoint responds (`curl http://localhost:8787/api/info`)
- [ ] Error handling works (404 on invalid endpoints)

**Status: ⏳ Ready to Verify**

---

### **Integration 2: Wrangler CLI ↔ Cloudflare Account**

- [ ] Wrangler authenticated (`wrangler status` shows account)
- [ ] Cloudflare API token stored locally
- [ ] KV namespace created and bound
- [ ] D1 database created (staging & production)
- [ ] Project deployed to staging
- [ ] Staging endpoint accessible online
- [ ] Project deployed to production
- [ ] Production endpoint accessible online
- [ ] Both environments isolated and independent

**Status: ⏳ Ready to Verify**

---

## 🎯 Success Criteria

| Criterion | How to Verify | Status |
|-----------|---------------|--------|
| **CLI Installed** | `wrangler --version` returns version | ⏳ |
| **Authenticated** | `wrangler status` shows email | ⏳ |
| **Project Created** | Files exist in backend/ | ⏳ |
| **Local Dev Works** | `npm run dev` starts server | ⏳ |
| **Endpoints Respond** | curl tests return JSON | ⏳ |
| **Staging Deployed** | URL accessible online | ⏳ |
| **Production Deployed** | URL accessible online | ⏳ |

---

## 📋 Pre-Implementation Checklist

Before we start, confirm you have:

- [ ] Cloudflare account created (free tier OK)
- [ ] Terminal/PowerShell access on your machine
- [ ] Administrator access (for global npm install)
- [ ] Node.js v18+ installed
- [ ] Internet connection
- [ ] 30-60 minutes available
- [ ] GitHub repository updated with latest (git pull)

---

## 🚀 Ready to Start Implementation?

I'm ready to guide you through each step with real-time verification. 

**Let me know:**
1. Are all pre-implementation items checked?
2. Should I start with STEP 1 (Install Wrangler)?

Once you confirm, I'll provide exact commands and verify each step completes successfully. ✅

---

## 📞 Support During Implementation

If any step fails:
1. Share the error message
2. I'll diagnose and provide fix
3. Continue to next step
4. No backtracking unless necessary

This is a linear path with verification checkpoints. We'll get it working! 🎯
