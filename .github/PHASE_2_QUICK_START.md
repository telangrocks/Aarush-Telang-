# Phase 2: Wrangler & Cloudflare Backend Setup - Quick Reference

**Status:** Ready to Start 🚀  
**Focus:** Backend Infrastructure (Cloudflare Workers)  
**Duration:** ~4-6 hours (with testing)

---

## ⚡ TL;DR - Your Next 5 Steps

### **1. Install Wrangler (15 min)**
```bash
npm install -g wrangler
wrangler login
wrangler --version  # Verify
```

### **2. Create Cloudflare Workers Project (30 min)**
```bash
cd backend
wrangler init
# Select: TypeScript, Yes, No (Git already init)
```

### **3. Create Basic API Endpoint (30 min)**
Edit `backend/src/index.ts`:
```typescript
export default {
  async fetch(request: Request) {
    return new Response(JSON.stringify({ 
      status: 'ok', 
      message: 'CryptoPulse API' 
    }), { headers: { 'Content-Type': 'application/json' } });
  }
};
```

Test locally:
```bash
npm run dev
# curl http://localhost:8787/health
```

### **4. Set Up GitHub Secrets (45 min)**
Go to GitHub repo → Settings → Secrets → Add:
- `WRANGLER_API_TOKEN` (from Cloudflare account)
- `DATABASE_URL_STAGING` (PostgreSQL/Supabase)
- `DATABASE_URL_PRODUCTION` (PostgreSQL/Supabase)

### **5. Update Deploy Workflow (1 hour)**
Add to `.github/workflows/deploy.yml`:
```yaml
deploy-backend:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: 'npm'
    - run: npm ci
      working-directory: backend
    - run: npx wrangler deploy --env staging
      working-directory: backend
      if: github.ref == 'refs/heads/staging'
      env:
        WRANGLER_API_TOKEN: ${{ secrets.WRANGLER_API_TOKEN }}
```

---

## 🔑 Key Files You'll Create

| File | Purpose | Status |
|------|---------|--------|
| `backend/wrangler.toml` | Cloudflare config | Auto-created |
| `backend/src/index.ts` | API entry point | Create |
| `backend/package.json` | Dependencies | Auto-updated |
| `.github/workflows/deploy.yml` | Deploy job | Modify |

---

## 📋 Verification Checklist

- [ ] Wrangler installed globally (`wrangler --version`)
- [ ] Authenticated with Cloudflare (`wrangler status`)
- [ ] Project initialized in backend/ (`wrangler.toml` exists)
- [ ] Local dev server works (`npm run dev`)
- [ ] Health endpoint responds (curl test)
- [ ] GitHub Secrets configured (3 secrets added)
- [ ] Deploy workflow updated (Wrangler job added)
- [ ] Workflow triggers on push to staging

---

## 🎯 Success = All 3 Tests Pass

| Test | Command | Expected Result |
|------|---------|-----------------|
| **Local Dev** | `npm run dev` | Server starts on :8787 ✅ |
| **Health Check** | `curl http://localhost:8787` | JSON response ✅ |
| **Deploy Test** | Push to staging branch | Green check in Actions ✅ |

---

## ❓ Prerequisites

- [ ] Cloudflare account (free tier OK)
- [ ] PostgreSQL or Supabase database (even test is fine)
- [ ] Cloudflare API token (generate in account settings)
- [ ] Database connection string

---

## 🚀 Ready to Start?

Choose your approach:

**Option A: Guided** (Recommended)
- I provide exact commands & code
- We verify each step
- Fastest & safest way

**Option B: Self-Guided**
- Follow the main guide (NEXT_PHASE_WRANGLER_SETUP.md)
- Share screenshots when done
- Get feedback & corrections

**Which would you prefer?**
