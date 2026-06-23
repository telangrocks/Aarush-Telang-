# Execution Plan: Wrangler CLI Integration Phase

**Status:** Infrastructure Layer - Wrangler & Cloudflare Setup  
**Focus:** Two Integrations Only  
**Stack:** Cloudflare Services Exclusively  
**Timeline:** 30-60 minutes per integration

---

## 🎯 Mission

Establish and verify:
1. **Wrangler CLI ↔ Local Development** (testing locally)
2. **Wrangler CLI ↔ Cloudflare Account** (deploy online)

No application features. Infrastructure only.

---

## 📋 Pre-Implementation Requirements

### **Verify Before Starting**

```
☑ Cloudflare Account Status
  ├─ Account created (free tier minimum)
  ├─ Email verified
  ├─ API tokens can be created
  └─ Zone/domain ready (optional, can use *.workers.dev)

☑ Local Machine Setup
  ├─ Node.js v18+ installed
  ├─ npm v9+ installed  
  ├─ Terminal/PowerShell access
  ├─ Administrator permissions
  └─ Internet connection stable

☑ Project Repository
  ├─ GitHub repo cloned locally
  ├─ All Phase 1 files present
  ├─ CI/CD workflows verified
  └─ Ready for backend setup
```

**Estimated Pre-Check:** 5 minutes

---

## 🔄 Two-Phase Implementation

### **Phase 2A: Local Development Integration**
- Install Wrangler CLI
- Create project structure
- Configure for local development
- Test endpoints locally
- **Outcome:** Full local environment ready

### **Phase 2B: Cloudflare Account Integration**
- Authenticate with account
- Create cloud resources (KV, D1)
- Deploy to staging
- Deploy to production
- **Outcome:** Live endpoints on Cloudflare

---

## 🚀 PHASE 2A: LOCAL DEVELOPMENT INTEGRATION

### **Duration:** ~20 minutes

### **STEP 1: Install Wrangler CLI**

**Command:**
```powershell
npm install -g wrangler
```

**Verify:**
```powershell
wrangler --version
```

**Expected:** Shows version number (e.g., `wrangler 3.40.0`)

**If fails:** 
- Check Node.js installed: `node --version`
- Check npm: `npm --version`
- May need admin terminal

---

### **STEP 2: Navigate to Backend Directory**

**Command:**
```powershell
cd "c:\Crypto Pulse ( New)\backend"

# Verify location
pwd
```

**Expected:** Shows path to backend directory

---

### **STEP 3: Initialize Wrangler Project**

**Command:**
```powershell
wrangler init
```

**Interactive Prompts** - Answer as shown:
```
✔ What would you like to start with? › Basic worker
✔ Create a git repository? … no
✔ Type: TypeScript
✔ Test your TypeScript worker: yes
```

**Files Created:**
```
backend/
├── wrangler.toml
├── src/index.ts
├── src/index.test.ts
├── tsconfig.json
├── package.json
├── package-lock.json
├── .gitignore
└── README.md
```

---

### **STEP 4: Update wrangler.toml Configuration**

**File:** `backend/wrangler.toml`

**Replace entire content with:**

```toml
name = "crypto-pulse-backend"
type = "javascript"
main = "src/index.ts"
compatibility_date = "2026-06-23"
compatibility_flags = ["nodejs_compat"]

[build]
command = "npm run build"
cwd = "./backend"
watch_paths = ["src/**/*.ts"]

[env.development]
name = "crypto-pulse-api-dev"
routes = [
  { pattern = "localhost:8787/*", zone_id = "dev" }
]
vars = { ENVIRONMENT = "development", LOG_LEVEL = "debug" }

[env.staging]
name = "crypto-pulse-api-staging"
vars = { ENVIRONMENT = "staging", LOG_LEVEL = "info" }

[env.production]
name = "crypto-pulse-api"
vars = { ENVIRONMENT = "production", LOG_LEVEL = "warn" }
```

---

### **STEP 5: Update src/index.ts**

**File:** `backend/src/index.ts`

**Replace entire content with:**

```typescript
export default {
  async fetch(
    request: Request,
    env: any,
    ctx: any
  ): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

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

    if (pathname === '/api/info') {
      return new Response(
        JSON.stringify({
          name: 'CryptoPulse Trading Bot API',
          version: '1.0.0',
          endpoints: [
            { path: '/health', method: 'GET' },
            { path: '/api/info', method: 'GET' },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(
      JSON.stringify({
        error: 'Not Found',
        message: `Endpoint '${pathname}' not found`,
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  },
};
```

---

### **STEP 6: Install Dependencies**

**Command:**
```powershell
npm install
```

**Expected Output:**
```
added XX packages
npm notice created a lockfile
```

---

### **STEP 7: Build the Project**

**Command:**
```powershell
npm run build
```

**Expected Output:**
```
> npm run build
Successfully compiled TypeScript
✨ Output written to dist/
```

---

### **STEP 8: Start Local Development Server**

**Command:**
```powershell
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

**Server is running!** ✅

---

### **STEP 9: Test Local Endpoints**

**Keep dev server running, open NEW terminal/PowerShell window**

**Test 1: Health Check**
```powershell
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
```powershell
curl http://localhost:8787/api/info
```

**Expected Response:**
```json
{
  "name": "CryptoPulse Trading Bot API",
  "version": "1.0.0",
  "endpoints": [
    { "path": "/health", "method": "GET" },
    { "path": "/api/info", "method": "GET" }
  ]
}
```

**Test 3: 404 Error**
```powershell
curl http://localhost:8787/invalid
```

**Expected Response:**
```json
{
  "error": "Not Found",
  "message": "Endpoint '/invalid' not found"
}
```

---

### **✅ PHASE 2A COMPLETE**

**Integration 1 Status:**
- [x] Wrangler CLI installed
- [x] Local project created
- [x] Configuration complete
- [x] Dependencies installed
- [x] Build successful
- [x] Dev server running
- [x] Endpoints responding
- [x] Error handling works

**Next:** Phase 2B (Cloudflare Account Integration)

---

## 🚀 PHASE 2B: CLOUDFLARE ACCOUNT INTEGRATION

### **Duration:** ~25 minutes

### **STEP 1: Authenticate with Cloudflare**

**Command:**
```powershell
wrangler login
```

**What happens:**
1. Browser opens (or shows link)
2. Login to Cloudflare account
3. Authorize Wrangler
4. Token saved locally

**Expected Output:**
```
⛅ wrangler login
Attempting to login with Cloudflare...
Opening browser: https://dash.cloudflare.com/...
Successfully authenticated with Cloudflare!
```

**Verify:**
```powershell
wrangler status
```

**Expected:** Shows your Cloudflare account email

---

### **STEP 2: Create KV Namespace for Caching**

**Commands:**
```powershell
# Production KV
wrangler kv:namespace create "KV_STORE"

# Staging KV
wrangler kv:namespace create "KV_STORE" --preview
```

**Expected Output:**
```
⛅ wrangler
✨ Created KV namespace with ID: abc123...
Add the following to your wrangler.toml:

[[kv_namespaces]]
binding = "KV_STORE"
id = "abc123..."
```

**Note the IDs** - you'll need them in next step

---

### **STEP 3: Create D1 Databases**

**Commands:**
```powershell
# Create staging database
wrangler d1 create crypto-pulse-staging

# Create production database
wrangler d1 create crypto-pulse-production
```

**Expected Output:**
```
✨ Created database crypto-pulse-staging with ID: xxxx...
Add the following to your wrangler.toml:

[[d1_databases]]
binding = "DB"
database_name = "crypto-pulse-staging"
database_id = "xxxx..."
```

**Note the IDs** - needed in wrangler.toml

---

### **STEP 4: Update wrangler.toml with Resource IDs**

**Get IDs from previous commands and add to `backend/wrangler.toml`:**

```toml
# ... existing configuration ...

[env.staging]
name = "crypto-pulse-api-staging"
vars = { ENVIRONMENT = "staging", LOG_LEVEL = "info" }

# KV Binding for Staging
[[kv_namespaces]]
binding = "KV_STORE"
id = "YOUR_STAGING_KV_ID"
preview_id = "YOUR_STAGING_PREVIEW_KV_ID"

# D1 Binding for Staging
[[d1_databases]]
binding = "DB"
database_name = "crypto-pulse-staging"
database_id = "YOUR_STAGING_DB_ID"

[env.production]
name = "crypto-pulse-api"
vars = { ENVIRONMENT = "production", LOG_LEVEL = "warn" }

# KV Binding for Production
[[kv_namespaces]]
binding = "KV_STORE"
id = "YOUR_PRODUCTION_KV_ID"

# D1 Binding for Production
[[d1_databases]]
binding = "DB"
database_name = "crypto-pulse-production"
database_id = "YOUR_PRODUCTION_DB_ID"
```

---

### **STEP 5: Deploy to Staging**

**Command:**
```powershell
wrangler deploy --env staging
```

**Expected Output:**
```
✨ Uploaded crypto-pulse-api-staging
✨ Published your Worker to
https://crypto-pulse-api-staging.telangrocks.workers.dev
```

**Test Staging Endpoint:**
```powershell
curl https://crypto-pulse-api-staging.telangrocks.workers.dev/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "service": "CryptoPulse API",
  "version": "1.0.0",
  "environment": "staging",
  "timestamp": "..."
}
```

---

### **STEP 6: Deploy to Production**

**Command:**
```powershell
wrangler deploy --env production
```

**Expected Output:**
```
✨ Uploaded crypto-pulse-api
✨ Published your Worker to
https://crypto-pulse-api.telangrocks.workers.dev
```

**Test Production Endpoint:**
```powershell
curl https://crypto-pulse-api.telangrocks.workers.dev/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "service": "CryptoPulse API",
  "version": "1.0.0",
  "environment": "production",
  "timestamp": "..."
}
```

---

### **✅ PHASE 2B COMPLETE**

**Integration 2 Status:**
- [x] Wrangler authenticated
- [x] KV namespaces created
- [x] D1 databases created
- [x] wrangler.toml updated with IDs
- [x] Deployed to staging
- [x] Staging endpoint live & responding
- [x] Deployed to production
- [x] Production endpoint live & responding

---

## ✅ BOTH INTEGRATIONS VERIFIED

### **Integration 1: Wrangler CLI ↔ Local Development**
```
Status: ✅ COMPLETE

Local environment fully operational:
├─ Wrangler CLI installed globally
├─ Project structure created in /backend
├─ wrangler.toml configured
├─ TypeScript compiled successfully
├─ npm dev server running on :8787
├─ Health endpoint responding
├─ API info endpoint responding
└─ Error handling working correctly
```

### **Integration 2: Wrangler CLI ↔ Cloudflare Account**
```
Status: ✅ COMPLETE

Cloud infrastructure fully operational:
├─ Wrangler authenticated with Cloudflare
├─ KV cache namespaces created (2 environments)
├─ D1 databases created (2 environments)
├─ Staging worker deployed online
├─ Staging endpoints responding
├─ Production worker deployed online
└─ Production endpoints responding
```

---

## 🎯 Next Steps After Integration

Once both integrations are verified:

1. **Commit & Push** infrastructure changes to GitHub
2. **Update CI/CD** pipeline to include Wrangler deployment
3. **Begin Application Development** (with infrastructure in place)
4. **Build API Endpoints** for trading functionality

---

## 📊 Quick Reference: Active Endpoints

**Local Development:**
- Health: `http://localhost:8787/health`
- Info: `http://localhost:8787/api/info`

**Staging (Online):**
- Health: `https://crypto-pulse-api-staging.telangrocks.workers.dev/health`
- Info: `https://crypto-pulse-api-staging.telangrocks.workers.dev/api/info`

**Production (Online):**
- Health: `https://crypto-pulse-api.telangrocks.workers.dev/health`
- Info: `https://crypto-pulse-api.telangrocks.workers.dev/api/info`

---

## ✨ Infrastructure Layer Complete

You now have:
- ✅ Professional Cloudflare Workers backend
- ✅ Three isolated environments (dev/staging/prod)
- ✅ KV cache for performance
- ✅ D1 database for persistence
- ✅ Full local development workflow
- ✅ One-command deployment automation

**Ready to build application features!** 🚀
