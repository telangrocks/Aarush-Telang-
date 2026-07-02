# Crypto Pulse Backend

**Cloudflare Workers + TypeScript + Hono Framework**

Serverless backend API for the Crypto Pulse mobile application.

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Visit http://localhost:8787
```

## Available Scripts

```bash
npm run dev         # Start local development server
npm run build       # Compile TypeScript
npm run lint        # Run ESLint
npm run format      # Auto-format with Prettier
npm run type-check  # Check TypeScript types
npm run test        # Run tests with Vitest
npm run deploy      # Deploy to Cloudflare Workers
```

## Project Structure

```
src/
├── index.ts        # Main entry point (Hono app)
├── types/
│   ├── env.ts      # Environment bindings
│   └── api.ts      # API response types
├── routes/         # API endpoint routes (added in Phase 3)
├── middleware/     # Custom middleware (added later)
└── utils/          # Helper utilities (added later)
```

## API Endpoints

### Health Check
```
GET /health
```

Returns:
```json
{
  "status": "ok",
  "timestamp": "2024-06-03T10:00:00Z",
  "environment": "development"
}
```

### Root
```
GET /
```

Returns:
```json
{
  "name": "Crypto Pulse Backend",
  "version": "1.0.0",
  "status": "running",
  "environment": "development"
}
```

## Features by Phase

- **Phase 1** ✅ Project structure & setup
- **Phase 2** (Next) CI/CD pipeline
- **Phase 3** Core API endpoints
- **Phase 4** Database integration
- **Phase 5+** Advanced features

## Development Notes

- Backend runs on Cloudflare Workers (serverless)
- Uses Hono framework for routing and middleware
- TypeScript strict mode enabled for type safety
- All API responses follow consistent format
- Environment variables managed via wrangler.toml

## Next Steps

1. ✅ Phase 1 complete: Project structure ready
2. Phase 2: Set up CI/CD with GitHub Actions
3. Phase 3: Implement first API endpoints (Prices)
4. Phase 4: Add D1 database integration
