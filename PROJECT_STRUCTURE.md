# Project Structure & Organization

**Last Updated:** 2026-06-23  
**Status:** Updated for Kotlin Compose and Hono D1 Worker ✅

---

## 📁 Directory Tree

```
project-root/
│
├── 📄 PROJECT_CONTEXT.md          # ← Main project overview
├── 📄 PROGRESS.md                 # ← Task tracking & session notes
├── 📄 ARCHITECTURE.md             # ← Tech stack & design decisions
├── 📄 PROJECT_STRUCTURE.md        # ← This file
├── 📄 README.md                   # ← GitHub repository README
├── 📄 .gitignore                  # ← Git ignore rules
│
├── 📂 backend/
│   ├── src/
│   │   ├── index.ts               # Main entry point (Hono App)
│   │   ├── routes/                # Endpoint routing
│   │   │   ├── prices.ts          # Live crypto price routing
│   │   │   ├── watchlist.ts       # Watchlist management
│   │   │   ├── portfolio.ts       # Portfolio transactions
│   │   │   └── news.ts            # Crypto news aggregator
│   │   └── types/                 # Custom type definitions
│   │       └── env.ts             # Cloudflare environment bindings
│   ├── tests/
│   │   └── api.test.ts            # Vitest integration tests
│   ├── wrangler.toml              # Wrangler / Worker configurations
│   ├── package.json               # Backend dependencies
│   ├── tsconfig.json              # TypeScript configuration
│   └── schema.sql                 # D1 Database Schema script
│
├── 📂 mobile/
│   ├── build.gradle.kts           # Root gradle script
│   ├── settings.gradle.kts        # Gradle settings include app
│   └── app/
│       ├── build.gradle.kts       # App Gradle configuration
│       ├── src/
│       │   ├── main/
│       │   │   ├── AndroidManifest.xml # App Manifest
│       │   │   └── java/com/cryptopulse/app/
│       │   │       ├── MainActivity.kt # Entry Activity
│       │   │       ├── CryptoPulseApp.kt # Application Class
│       │   │       ├── data/          # Network, Room DB, Repositories
│       │   │       │   ├── remote/    # Retrofit interface and models
│       │   │       │   ├── local/     # Room Entity, DAO, Database
│       │   │       │   └── repository/ # Single source of truth repositories
│       │   │       ├── di/            # Hilt Module DI declarations
│       │   │       ├── ui/            # UI components and view models
│       │   │       │   ├── theme/     # Color, Typography, Shapes
│       │   │       │   ├── screens/   # Home, Charts, Watchlist, Portfolio, News
│       │   │       │   └── components/ # Custom charts, loaders, items
│       │   │       └── utils/         # Helper utility classes
│       │   └── res/               # Android drawables, values, mipmaps
│       └── src/test/              # JUnit and Mockito unit tests
│
├── 📂 docs/
│   └── API_SPECIFICATION.md       # API endpoint specification
│
└── 📂 .github/
    └── workflows/
        └── ci-cd.yml              # CI Build checking (Gradle + Worker)
```
