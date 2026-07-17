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
│   │   ├── index.test.ts          # Hono route integration tests
│   │   ├── crypto.ts              # WebCrypto credentials helper
│   │   ├── market-analysis.ts     # Indicators (RSI/MACD/EMA) and scanner scoring
│   │   ├── trading-bot.ts         # Stateful Durable Object DO loops
│   │   ├── trading-bot.test.ts    # Integration & Exchange validation tests
│   │   ├── handlers/              # Endpoint controller handlers
│   │   │   ├── auth.ts            # User auth, registration, login
│   │   │   ├── exchange.ts        # Connect, disconnect, balance query
│   │   │   ├── notifications.ts   # Device push registrations
│   │   │   ├── positions.ts       # Open/Closed trade positions queries
│   │   │   └── user.ts            # Profile management
│   │   └── exchanges/             # Exchange API adapters
│   │       ├── BaseExchange.ts    # Abstract interface for adapters
│   │       ├── BinanceExchange.ts # Spot Binance client
│   │       ├── BybitExchange.ts   # V5 Spot Bybit client
│   │       ├── DeltaExchange.ts   # Staging/Prod Delta Exchange client
│   │       ├── ExchangeFactory.ts # Instantiate appropriate adapter
│   │       ├── errors.ts          # Centralized error classification
│   │       └── index.ts           # Barrel file
│   ├── scripts/                   # Validation, testing and helper scripts
│   │   ├── feature-testing-validation.js
│   │   ├── qa-validation.js
│   │   ├── smoke-test.js
│   │   └── validate-trading-flow.mjs
│   ├── migrations/                # Database migrations schema scripts (0000 - 0016)
│   ├── wrangler.toml              # Wrangler / Worker configurations
│   ├── package.json               # Backend dependencies
│   ├── tsconfig.json              # TypeScript configuration
│   └── tsconfig.json              # TypeScript config
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
│       │   │       ├── data/          # Network, API, local storage
│       │   │       ├── di/            # Hilt Module DI declarations
│       │   │       ├── service/       # FCM background services
│       │   │       └── ui/            # UI components and Composable screens
│       │   └── res/               # Android drawables, values, mipmaps
│       └── src/test/              # JUnit and Mockito unit tests
│
├── 📂 docs/
│   └── complete_schema.sql        # Reference SQL schema script
│
└── 📂 .github/
    └── workflows/
        ├── deploy.yml             # CD deployment to Cloudflare
        └── ai-feature-testing.yml # Android Emulator features test run
```
