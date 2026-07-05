# CI/CD Audit and Recommendations

## Current workflow count

The repository currently has 3 workflows:

1. `.github/workflows/ci.yml`
2. `.github/workflows/deploy.yml`
3. `.github/workflows/security.yml`

## Audit summary

The previous workflow setup was too ambitious for the current maturity of the codebase. It included several third-party scanners, placeholder deployment assumptions, and secret-dependent jobs that created noisy failures without advancing the main goal: getting the backend reliably built, deployed, and integrated with the Android app.

## Root causes of recurring workflow failures

### 1. Security workflow was overbuilt
- Multiple external tools required secrets that may not be configured (`SNYK_TOKEN`, `GITGUARDIAN_API_KEY`, Slack webhook, etc.)
- Several jobs were not aligned with the current repository contents
- Failures in optional scanners made the overall workflow look unstable

### 2. Deployment workflow had placeholder assumptions
- `backend/wrangler.toml` still contains a placeholder D1 `database_id`
- Deployment verification used fake example URLs
- Environment branching (`staging`/`production`) was more complex than the current project state justifies

### 3. CI was broader than necessary for the current phase
- The goal right now is stable backend and mobile build confidence, not enterprise-grade multi-environment automation
- Failing on too many unrelated jobs makes real progress harder to track

## Recommended workflow model

### CI (`ci.yml`)
Run on push/PR to `main`:
- backend install, lint, build, test
- Android build

### Deploy (`deploy.yml`)
Run on push to `main` when backend files change, or manually:
- install backend deps
- lint/build/test backend
- verify Wrangler config and required secrets
- apply D1 migrations
- deploy Worker

### Security (`security.yml`)
Run weekly or manually:
- backend `npm audit`
- CodeQL

This keeps security important without letting optional tooling derail day-to-day development.

## Why this is a better industry-standard fit

For a project at this stage, a strong pipeline is:
- small
- deterministic
- easy to understand
- tied to real deployment goals
- low-noise

A world-class setup is not the one with the most jobs. It is the one that gives reliable signal and supports shipping safely.

## Remaining prerequisite before deploy can pass

The backend deploy workflow will still fail until `backend/wrangler.toml` is updated with the real Cloudflare D1 database ID instead of the placeholder value.

## Recommended next execution order

1. Run `CI`
2. Fix remaining backend/mobile build issues until CI is green
3. Update real Cloudflare D1 config
4. Run `Deploy backend`
5. Verify mobile-to-backend integration
6. Move to emulator/E2E testing
