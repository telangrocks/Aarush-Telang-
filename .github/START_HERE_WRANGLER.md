# 🚀 START HERE: Wrangler CLI Integration - Step-by-Step

**Status:** Ready to Implement  
**Phase:** 2A & 2B - Wrangler & Cloudflare Setup  
**Timeline:** 50 minutes total  
**Outcome:** Production-ready backend infrastructure

---

## ✅ Pre-Flight Checklist

**Before starting, ensure you have:**

- [ ] Cloudflare account (free tier OK) - **You confirmed you have this**
- [ ] Node.js v18+ installed - Run: `node --version`
- [ ] npm v9+ installed - Run: `npm --version`
- [ ] Terminal/PowerShell access
- [ ] 50 minutes available
- [ ] This guide handy

---

## 🎯 Phase 2A: Local Development (20 minutes)

### Command 1: Install Wrangler CLI

Copy and run this command in PowerShell:

```powershell
npm install -g wrangler
```

**What happens:**
- Downloads Wrangler from npm registry
- Installs globally so you can use it anywhere
- Takes 1-2 minutes

**After running, verify with:**
```powershell
wrangler --version
```

Expected: Shows a version number (e.g., `wrangler 3.40.0`)

✅ **Move to Command 2 when this works**

---

### Command 2: Navigate to Backend Directory

Copy and run:

```powershell
cd "c:\Crypto Pulse ( New)\backend"
```

**Verify location:**
```powershell
pwd
```

Expected: Shows path ending in `...\backend`

✅ **Move to Command 3 when location is correct**

---

### Command 3: Initialize Wrangler Project

Copy and run:

```powershell
wrangler init
```

**When prompted, answer:**
```
? What would you like to start with? › Basic worker
? Create a git repository? › no
? Type: › TypeScript
? Test your TypeScript worker: › yes
```

**After completion:**
- New files created in backend/
- wrangler.toml, src/index.ts, package.json, etc.

✅ **Move to Command 4**

---

### Command 4: Update Configuration File

**File to edit:** `backend/wrangler.toml`

**Delete all content and replace with:**

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

**Save file** (Ctrl+S if using VS Code)

✅ **Move to Command 5**

---

### Command 5: Update API Endpoint

**File to edit:** `backend/src/index.ts`

**Delete all content and replace with:**

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

**Save file** (Ctrl+S)

✅ **Move to Command 6**

---

### Command 6: Install Dependencies

**Make sure you're still in backend/ directory, then run:**

```powershell
npm install
```

**Expected:**
- Takes 1-2 minutes
- Shows "added XX packages"
- Creates node_modules/ directory

✅ **Move to Command 7**

---

### Command 7: Build Project

**Run:**

```powershell
npm run build
```

**Expected:**
- TypeScript compiles
- Shows "Successfully compiled TypeScript"
- Creates dist/ directory

✅ **Move to Command 8**

---

### Command 8: Start Local Development Server

**Run:**

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

**DON'T CLOSE THIS TERMINAL** - Keep the dev server running!

✅ **Move to Command 9 (new terminal)**

---

### Command 9: Test Endpoints (New Terminal)

**IMPORTANT: Open a NEW PowerShell window/tab - don't close the dev server!**

**Test 1: Health Check**
```powershell
curl http://localhost:8787/health
```

**Expected Response:**
```json
{"status":"ok","service":"CryptoPulse API","version":"1.0.0","environment":"development","timestamp":"..."}
```

**Test 2: API Info**
```powershell
curl http://localhost:8787/api/info
```

**Expected Response:**
```json
{"name":"CryptoPulse Trading Bot API","version":"1.0.0","endpoints":[...]}
```

**Test 3: 404 Error**
```powershell
curl http://localhost:8787/invalid
```

**Expected Response:**
```json
{"error":"Not Found","message":"Endpoint '/invalid' not found"}
```

✅ **PHASE 2A COMPLETE!**

**Keep dev server running** - You'll need it for local testing

---

## 🎬 Next: Phase 2B - Cloudflare Account (25 minutes)

Once Phase 2A is confirmed working, proceed to Phase 2B:

**Phase 2B Steps:**
1. Authenticate Wrangler with Cloudflare
2. Create cloud resources (KV, D1)
3. Deploy to staging
4. Deploy to production
5. Verify endpoints online

**Where to find Phase 2B:**
- Open: `.github/WRANGLER_EXECUTION_PLAN.md`
- Section: "PHASE 2B: CLOUDFLARE ACCOUNT INTEGRATION"

---

## 📋 Quick Reference

**Local Dev Server:**
- Command: `npm run dev` (in backend/ directory)
- URL: `http://localhost:8787`
- Health endpoint: `http://localhost:8787/health`

**Stop Dev Server:**
- Press `Ctrl+C` in the terminal where it's running

**Restart if needed:**
- `npm run dev` again

---

## ❓ Troubleshooting Quick Fixes

| Problem | Solution |
|---------|----------|
| `wrangler: command not found` | Node.js not installed. Install from nodejs.org |
| `npm: command not found` | npm not installed with Node.js. Reinstall Node.js |
| `Port 8787 already in use` | Close other Wrangler servers or use different port |
| `TypeScript compilation errors` | Check index.ts for typos, ensure valid JSON in responses |
| `Cannot find module` | Run `npm install` in backend/ directory |

---

## ✨ Summary

**Phase 2A accomplishes:**
- ✅ Wrangler CLI installed
- ✅ Local project created
- ✅ Configuration complete
- ✅ Dependencies installed
- ✅ Build successful
- ✅ Dev server running
- ✅ Endpoints tested locally

**Next:** Follow Phase 2B in WRANGLER_EXECUTION_PLAN.md to deploy to Cloudflare!

---

**Ready? Let's build the backend! 🚀**
