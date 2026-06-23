# Next Phase: Wrangler CLI & Cloudflare Backend Setup

**Date:** 2026-06-23  
**Current Status:** Foundation Complete ✅ → Ready for Backend Infrastructure Phase  
**Focus:** Wrangler CLI Integration & Cloudflare Workers Configuration

---

## 📋 Summary of Completed Phase

✅ **Phase 1: Project Infrastructure** (COMPLETE)
```
✓ GitHub repository created and connected
✓ Local git workflow established
✓ Professional CI/CD pipeline configured (3 workflows)
✓ GitHub Actions active and ready
✓ Project structure scaffolded
✓ Documentation framework in place
```

---

## 🎯 Current Architecture Context

Your CryptoPulse project uses a **hybrid backend architecture**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers (Edge)                    │
│                   ┌──────────────────────────┐                  │
│                   │  API Endpoints (REST)    │                  │
│                   │  Request/Response Routes │                  │
│                   │  Request Validation      │                  │
│                   │  Authentication Guards   │                  │
│                   └──────────────────────────┘                  │
│                             ↓                                   │
│              Environment Variables & Config                     │
│              (Wrangler + GitHub Secrets)                        │
└─────────────────────────────────────────────────────────────────┘
                             ↓
        ┌───────────────────────────────────────┐
        │  External Database (PostgreSQL/Supabase)
        │  ├─ Market data (persistent)
        │  ├─ Trading pairs & analysis
        │  ├─ User preferences & settings
        │  └─ Trade history & logs
        └───────────────────────────────────────┘
```

**Rationale:**
- **Cloudflare Workers** = Lightweight, low-latency API edge processing
- **External DB** = Persistence, transactions, data durability
- **Separation** = Workers don't store state, DB handles all data

---

## 🚀 Next Phase: Wrangler CLI & Cloudflare Setup

### **Phase 2: Backend Infrastructure** (STARTING NOW)

```
Current Phase (Complete)                Next Phase (Starting)
═════════════════════════════════════════════════════════
1. GitHub repo setup ✅         →  4. Wrangler CLI setup
2. Local git workflow ✅         →  5. Cloudflare Workers project
3. CI/CD pipeline ✅            →  6. Environment management
4. Workflows active ✅          →  7. Backend API scaffold
                                →  8. Database connection
                                →  9. Deploy integration in CI/CD
```

---

## 📝 Step-by-Step Wrangler Setup Roadmap

### **Step 1: Install & Configure Wrangler CLI Locally**

**What:** Install Wrangler (Cloudflare's CLI tool for Workers management)

**Actions:**
```bash
# Install Wrangler globally
npm install -g wrangler

# Verify installation
wrangler --version  # Should show v3.x.x or later

# Authenticate with Cloudflare
wrangler login
# This opens Cloudflare dashboard to authorize your machine
# You'll receive an API token to confirm in terminal
```

**Output:**
```
✓ Wrangler installed globally
✓ Authenticated with Cloudflare account
✓ Ready to manage Workers projects
```

---

### **Step 2: Create Wrangler Project in Backend Directory**

**What:** Initialize a Cloudflare Workers project in `/backend`

**Actions:**
```bash
cd backend

# Create Wrangler project (select "Cloudflare Workers")
wrangler init

# Answer prompts:
#   - Name: CryptoPulse-API
#   - Type: "workers"
#   - TypeScript: Yes
#   - Git: No (already initialized in parent)
```

**Files Created:**
```
backend/
├── wrangler.toml          ← Configuration file
├── src/
│   └── index.ts           ← Main Worker entry point
├── tsconfig.json          ← TypeScript config
├── package.json           ← Dependencies
└── .gitignore
```

**wrangler.toml Structure:**
```toml
name = "CryptoPulse-API"
main = "src/index.ts"
compatibility_date = "2026-06-23"

[env.staging]
name = "CryptoPulse-API-staging"
route = "staging-api.cryptopulse.dev/*"

[env.production]
name = "CryptoPulse-API"
route = "api.cryptopulse.dev/*"
```

---

### **Step 3: Set Up Environment & Secrets Management**

**What:** Define environment variables for different deployment stages

**Create: `backend/wrangler.toml` with environments**

```toml
[env.development]
vars = { ENVIRONMENT = "development", LOG_LEVEL = "debug" }

[env.staging]
vars = { ENVIRONMENT = "staging", LOG_LEVEL = "info" }
route = "staging-api.cryptopulse.dev/*"

[env.production]
vars = { ENVIRONMENT = "production", LOG_LEVEL = "warn" }
route = "api.cryptopulse.dev/*"
```

**Secrets to Configure (via GitHub + Cloudflare):**
```
WRANGLER_API_TOKEN          ← Cloudflare API token (for GitHub Actions)
DATABASE_URL_STAGING        ← PostgreSQL/Supabase staging
DATABASE_URL_PRODUCTION     ← PostgreSQL/Supabase production
API_KEY_ENCRYPTION_SECRET   ← Encryption key for API secrets
EXCHANGE_API_KEY_BINANCE    ← Binance API credentials
EXCHANGE_API_SECRET_BINANCE ← Binance API secret (encrypted)
```

---

### **Step 4: Create Basic Worker Entry Point**

**What:** Build minimal Worker to verify Cloudflare connection

**File: `backend/src/index.ts`**

```typescript
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: process.env.ENVIRONMENT || 'unknown'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Placeholder API response
    return new Response(JSON.stringify({
      message: 'CryptoPulse API',
      version: '1.0.0',
      endpoints: ['/health', '/api/v1/...']
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
```

**Verification:**
```bash
cd backend
npm run dev
# Should start local Wrangler server on http://localhost:8787
# Test: curl http://localhost:8787/health
```

---

### **Step 5: Integrate Wrangler into Deployment Pipeline**

**What:** Update GitHub Actions deploy.yml to use Wrangler

**In `.github/workflows/deploy.yml`, add Wrangler deploy job:**

```yaml
deploy-backend:
  name: Deploy Backend to Cloudflare
  runs-on: ubuntu-latest
  needs: pre-deploy-checks
  environment:
    name: ${{ env.ENVIRONMENT }}
    url: ${{ steps.deploy.outputs.deployment-url }}
  
  steps:
    - uses: actions/checkout@v4
    
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: 'npm'
        cache-dependency-path: 'backend/package-lock.json'
    
    - name: Install dependencies
      run: npm ci
      working-directory: backend
    
    - name: Deploy to Cloudflare (Staging)
      if: github.ref == 'refs/heads/staging'
      run: npx wrangler deploy --env staging
      working-directory: backend
      env:
        WRANGLER_API_TOKEN: ${{ secrets.WRANGLER_API_TOKEN }}
    
    - name: Deploy to Cloudflare (Production)
      if: github.ref == 'refs/heads/main'
      run: npx wrangler deploy --env production
      working-directory: backend
      env:
        WRANGLER_API_TOKEN: ${{ secrets.WRANGLER_API_TOKEN }}
    
    - name: Verify deployment
      run: |
        echo "✓ Backend deployed successfully"
        echo "Staging URL: https://staging-api.cryptopulse.dev"
        echo "Production URL: https://api.cryptopulse.dev"
```

---

### **Step 6: Set Up GitHub Secrets for Cloudflare**

**What:** Configure encrypted secrets for GitHub Actions to deploy

**Actions in GitHub Repository:**
1. Go to **Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Add the following secrets:

| Secret Name | Value | Where to Get |
|-------------|-------|-------------|
| WRANGLER_API_TOKEN | Cloudflare API token | Cloudflare dashboard → Account settings → API tokens |
| DATABASE_URL_STAGING | PostgreSQL/Supabase staging connection | Supabase dashboard → Database → Connection string |
| DATABASE_URL_PRODUCTION | PostgreSQL/Supabase production connection | Supabase dashboard → Database → Connection string |
| API_KEY_ENCRYPTION_SECRET | Random 32-char string | Generate: `openssl rand -hex 16` |

---

### **Step 7: Create Database Schema & Initialization**

**What:** Set up PostgreSQL database structure

**File: `backend/scripts/init-db.sql`**

```sql
-- Market Data Table
CREATE TABLE market_data (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL UNIQUE,
    exchange VARCHAR(50) NOT NULL,
    price DECIMAL(20, 8) NOT NULL,
    volume_24h DECIMAL(20, 2),
    market_cap DECIMAL(20, 2),
    change_24h DECIMAL(5, 2),
    risk_score DECIMAL(3, 2),
    quality_score DECIMAL(3, 2),
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Trading Pairs Table
CREATE TABLE trading_pairs (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    user_id UUID NOT NULL,
    strategy VARCHAR(100) NOT NULL,
    parameters JSONB,
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Trade Signals Table
CREATE TABLE trade_signals (
    id SERIAL PRIMARY KEY,
    trading_pair_id INTEGER REFERENCES trading_pairs(id),
    signal_type VARCHAR(50) NOT NULL,
    confidence DECIMAL(3, 2),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB
);

-- Indexes for performance
CREATE INDEX idx_market_data_symbol ON market_data(symbol);
CREATE INDEX idx_trading_pairs_user ON trading_pairs(user_id);
CREATE INDEX idx_trade_signals_pair ON trade_signals(trading_pair_id);
```

---

## 🎯 Immediate Action Items (Next 24-48 hours)

### **Priority 1: Setup Wrangler Locally**
- [ ] Install Wrangler CLI globally
- [ ] Authenticate with Cloudflare account
- [ ] Verify installation with `wrangler --version`

**Estimated Time:** 15 minutes

---

### **Priority 2: Initialize Cloudflare Workers Project**
- [ ] Create Wrangler project in `backend/`
- [ ] Configure `wrangler.toml` with environments
- [ ] Review generated project structure
- [ ] Test local dev server

**Estimated Time:** 30 minutes

---

### **Priority 3: Create Basic Worker Code**
- [ ] Implement `/health` endpoint in `src/index.ts`
- [ ] Add error handling and logging
- [ ] Test locally with curl/Postman

**Estimated Time:** 30 minutes

---

### **Priority 4: Prepare GitHub Secrets**
- [ ] Generate Cloudflare API token
- [ ] Create test PostgreSQL database
- [ ] Prepare connection strings
- [ ] Document all secrets

**Estimated Time:** 45 minutes

---

### **Priority 5: Update GitHub Actions Deploy Pipeline**
- [ ] Integrate Wrangler deploy job
- [ ] Test deploy workflow with staging environment
- [ ] Verify deployment URL is accessible

**Estimated Time:** 1 hour

---

## 📊 Phase 2 Deliverables

By end of this phase, you should have:

```
✓ Wrangler CLI installed and authenticated
✓ Cloudflare Workers project created
✓ Environment configuration (dev/staging/prod)
✓ Basic API health check endpoint working
✓ GitHub Secrets configured for auto-deployment
✓ GitHub Actions deploy pipeline integrated
✓ Database schema designed
✓ Deployment tested and verified
```

---

## 🚦 Success Criteria

| Criterion | How to Verify |
|-----------|---------------|
| Wrangler installed | `wrangler --version` shows v3+ |
| Cloudflare authenticated | `wrangler status` shows account info |
| Local development works | `npm run dev` starts server on :8787 |
| Health endpoint works | `curl http://localhost:8787/health` returns JSON |
| GitHub Secrets configured | No failures in deploy workflow |
| Staging deployment succeeds | GitHub Actions workflow shows green check |
| Production ready | Main branch deployment is automated |

---

## 📚 Additional Resources

**Official Docs:**
- Wrangler CLI: https://developers.cloudflare.com/workers/wrangler/
- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Wrangler Configuration: https://developers.cloudflare.com/workers/wrangler/configuration/

**Environment Setup:**
- `.github/WORKFLOWS_GUIDE.md` — How to use deploy workflow
- `DEPLOYMENT_COMPLETE.md` — Current deployment status
- `ARCHITECTURE.md` — System architecture reference

---

## 🎯 Next Steps

**Option A: Guided Setup (Recommended)**
I will guide you through each step with exact commands, code snippets, and verification steps.

**Option B: Self-Guided**
You set up Wrangler locally and share screenshots of each step for verification.

**Option C: Phased Approach**
We complete one priority at a time, testing each before moving to the next.

---

## ✅ Recommendation

**I recommend Option A (Guided Setup)** because:
1. Wrangler configuration has many environment-specific details
2. GitHub Secrets must be precisely configured to avoid deployment failures
3. Cloudflare billing/routing requires careful setup
4. We should test each step before moving forward

This will ensure your backend infrastructure is production-ready from day one.

---

**Ready to proceed? Let me know which option you prefer, and we'll begin immediately! 🚀**
