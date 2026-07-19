# Aarush Telang — Project Onboarding & Setup Guide
## 📄 `MCP_SERVER_AND_AUTONOMOUS_SETUP.md`
**Last Updated:** 2026-07-19

This document is the **single source of truth** for the repository. When initiating a new development or agent session, the AI agent **must read this document first** to understand the setup, development workflows, testing, and constraints.

---

## 1. 🏗️ Project Overview & Architecture
This project is **Crypto Pulse**, a production-grade crypto tracker app consisting of a serverless edge backend and a native Android application.

### High-Level System Architecture
```
  ┌─────────────────────────────────────────────────────────────┐
  │                     Mobile Application                      │
  │                  (Native Android / Kotlin / Compose)        │
  │                 (Runs on Android Emulator)                  │
  └──────────────────────────┬──────────────────────────────────┘
                             │
                      HTTP/REST API
                             │
  ┌──────────────────────────▼──────────────────────────────────┐
  │                   Backend Services                          │
  │                (TypeScript / Hono framework)                │
  │         (Deployed on Cloudflare Workers)                    │
  └──────────────────────────┬──────────────────────────────────┘
                             │
                          SQL/Bindings
                             │
  ┌──────────────────────────▼──────────────────────────────────┐
  │                      Database                               │
  │                (Cloudflare D1 SQLite)                       │
  └─────────────────────────────────────────────────────────────┘
```

*   **Frontend**: Native Android App utilizing **Kotlin**, **Jetpack Compose**, **Retrofit** (Network), **Room** (Local Cache), **Hilt** (Dependency Injection), and **Coroutines** (Concurrency).
*   **Backend**: Serverless API running on **Cloudflare Workers** using the **Hono** web framework, written in **TypeScript**.
*   **Database**: **Cloudflare D1** SQLite database bound directly to the Worker runtime.
*   **DevOps**: **GitHub Actions** for CI/CD, running automated linters, unit tests, and Wrangler deployment.

---

## 2. 🔌 Model Context Protocol (MCP) Server Setup & Integration
Antigravity utilizes the Model Context Protocol (MCP) to bridge AI models with system tools, browsers, and remote APIs.

### A. Chrome DevTools MCP Server (`chrome_devtools`)
*   **Purpose**: Enables the agent to interact with Chrome browsers and Android web views over the Chrome DevTools Protocol. Used for rendering validation, visual verification, and end-to-end user-flow validation.
*   **Environment Configuration**:
    *   `CHROME_DEVTOOLS_MCP_JS`: Points to the path of the DevTools MCP server handler script.
    *   `AGY_BROWSER_WS_URL`: The WebSocket URL of the active browser/emulator debugging socket (e.g., `ws://127.0.0.1:62337/devtools/browser/...`).
    *   `AGY_BROWSER_ACTIVE_PORT_FILE`: Path to the active port locking file.
*   **How the Agent Uses It**: Evaluates scripts and inspects DOM nodes inside the browser or web view.

### B. Cloudflare MCP Server (`cloudflare`)
*   **Purpose**: Manages Cloudflare resources (Workers, D1, Email routing, sending) directly via REST/GraphQL API.
*   **Endpoint**: `https://mcp.cloudflare.com/mcp`
*   **Available Tools**:
    *   `search`: Discovers available API endpoints (e.g., email sending, D1 query endpoints).
    *   `execute`: Executes queries/actions (e.g., querying D1 tables, checking email quotas, or sending automated notifications on deployment).

### C. Configuration Schema (`mcp_config.json`)
MCP servers are defined globally in `~/.gemini/config/mcp_config.json`.
```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "node",
      "args": ["C:/Users/shrik/AppData/Local/Programs/antigravity/resources/app.asar.unpacked/node_modules/@antigravity-ai/chrome-devtools-mcp/dist/index.js"]
    }
  }
}
```

---

## 3. 📁 Repository Structure
```
project-root/
├── .github/workflows/
│   ├── deploy.yml             # CD deployment workflow to Cloudflare Workers
│   └── ai-feature-testing.yml # Android Emulator feature testing (via Maestro)
│
├── backend/
│   ├── src/
│   │   ├── index.ts               # Hono main entry point
│   │   ├── crypto.ts              # WebCrypto encryption/decryption utilities
│   │   ├── market-analysis.ts     # Indicators (RSI, MACD, EMA) & scanners
│   │   ├── trading-bot.ts         # Stateful Durable Object logic
│   │   ├── handlers/              # Endpoint controllers (auth, profiles, watchlist)
│   │   └── exchanges/             # REST Adapter layer (Binance, Bybit, Delta)
│   ├── scripts/                   # Integration and smoke verification scripts
│   │   ├── feature-testing-validation.js
│   │   ├── qa-validation.js
│   │   ├── smoke-test.js
│   │   └── validate-trading-flow.mjs
│   ├── migrations/                # Cloudflare D1 migrations (0000 - 0016)
│   ├── wrangler.toml              # Wrangler/Workers configuration bindings
│   └── package.json               # Backend dependencies
│
├── mobile/
│   ├── build.gradle.kts           # Root gradle configuration
│   ├── settings.gradle.kts        # Module inclusion configurations
│   └── app/
│       ├── build.gradle.kts       # Mobile app dependencies and SDK configurations
│       ├── src/
│       │   ├── main/
│       │   │   ├── AndroidManifest.xml
│       │   │   └── java/com/cryptopulse/app/
│       │   │       ├── MainActivity.kt # Entry UI Host activity
│       │   │       ├── data/           # Repositories, cache, and Retrofit APIs
│       │   │       ├── di/             # Hilt modules
│       │   │       └── ui/             # Composable UI layers
│       │   └── test/              # Local JUnit tests
│       └── maestro/               # Maestro flow scripts for UI automation testing
│
└── docs/
    └── complete_schema.sql        # Reference SQL schema script
```

---

## 4. 🛠️ Dependencies & Required Environment

### Required Tools
1.  **Node.js (>= 18.0.0)**: Runtime for backend and automation scripts.
2.  **Java JDK (17)**: Required for building the Android application.
3.  **Android SDK**: Local path configured in `local.properties` (under `sdk.dir`).
4.  **Wrangler CLI**: For running and deploying Cloudflare Workers.
5.  **Git**: Version control.

### Key Environment Variables & Secrets
Ensure these are loaded in the environment or configured in GitHub secrets:
*   `GITHUB_PERSONAL_ACCESS_TOKEN`: Personal Access Token used for Git automation.
*   `WORKER_URL`: Base URL of the deployed Cloudflare Worker API.
*   `QA_EXCHANGE_API_KEY` / `QA_EXCHANGE_API_SECRET`: Optional credentials for verifying live exchange endpoints in tests.
*   `CLOUDFLARE_API_TOKEN`: Used by Wrangler for headless CLI deployments.

---

## 5. 💻 Local Development Setup

### A. Backend Setup
1.  Navigate to the `backend/` directory:
    ```bash
    cd backend
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Run the local development server (spins up local wrangler node):
    ```bash
    npm run dev
    ```

### B. Mobile App Setup
1.  Open the `mobile/` directory in Android Studio.
2.  Ensure `local.properties` exists with the correct SDK location:
    ```properties
    sdk.dir=C\:\\Users\\shrik\\AppData\\Local\\Android\\Sdk
    ```
3.  Verify compilation from the terminal:
    ```bash
    cd mobile
    .\gradlew.bat assembleDebug --stacktrace
    ```

---

## 6. 🧪 Testing Workflow

### A. Backend Testing (Unit & Integration)
Unit and integration tests are powered by **Vitest**. Database states are mocked/run using the Miniflare environment.
*   **Run All Tests**:
    ```bash
    cd backend
    npm test
    ```
*   **Run Specific Test File**:
    ```bash
    npx vitest run src/trading-bot.test.ts
    ```

### B. E2E QA Validation
Runs functional checks against the target worker endpoint:
```bash
cd backend
# Runs validation checks on auth, database status, and exchange interfaces
node scripts/qa-validation.js
```

---

## 7. 🚀 GitHub Automation, CI/CD & Deployment

### One-Command Git Automation
The project includes a PowerShell wrapper script `git_automation.ps1` at the repository root that acts as the primary commit & push controller.
*   **Usage**:
    ```powershell
    powershell -ExecutionPolicy Bypass -File .\git_automation.ps1
    ```
*   **Execution Flow**:
    1.  Reviews current Git status and diff changes.
    2.  Installs backend dependencies (`npm ci`).
    3.  Runs backend linter (`npm run lint`), build check (`npm run build`), and Vitest tests (`npm test`).
    4.  Runs Android debug compilation check (`.\gradlew.bat assembleDebug`).
    5.  Stages all modified files.
    6.  Utilizes local `ollama` model (e.g., `llama3.1`) to analyze the diff and generate a descriptive, standard-compliant commit message.
    7.  Commits and pushes to the current branch.

### GitHub Actions Pipelines
*   `deploy.yml`: Automatically deploys the backend worker to Cloudflare Workers upon merging changes into the `main` branch.
*   `ai-feature-testing.yml`: A standalone, isolated nightly runner that builds a throwaway debug APK, launches a macOS Android Emulator, and drives E2E user flows via Maestro (checks top coin selection, live market data, indicators, alert creation, and notification triggers).

---

## 8. 🛡️ Rules and Constraints for AI Agents
To ensure codebase stability and architecture preservation, all agents must adhere to the following rules:

### ⚠️ Never Modify Without Permission
*   **GitHub Workflows (`.github/workflows/*.yml`)**: Do not alter trigger logic or deploy configurations without explicit permission.
*   **Account Configurations (`backend/wrangler.toml`)**: Do not modify the target `account_id` or `database_id` values.
*   **Encryption Handlers (`backend/src/crypto.ts`)**: AES key lengths, algorithm parameters, and decryption routines must remain unchanged as they protect active user configurations.

### 📝 Core Guidelines
*   **Clean SQLite Migrations**: Never modify existing migration scripts (e.g., `migrations/0000_init.sql`). If a schema change is required, always generate a new migration file (e.g., `migrations/0017_update.sql`).
*   **Preserve Documentation**: Do not remove `PROJECT_CONTEXT.md` or `ARCHITECTURE.md`. Update them with new details whenever structural features are added.
*   **Code Quality**: Maintain ESLint configurations in the backend, and check Kotlin builds locally before writing changes.
*   **No Placeholders / Hardcoded Mocks**: Never commit mock strings ("mock-data", "dummy", "lorem-ipsum") to active api response fields. Always utilize the QA scanner script to verify responses before finalizing changes.

---

## 9. 🔍 Debugging & Troubleshooting

### A. D1 Migration Failures
*   **Symptom**: `Wrangler migration apply` fails because of a schema conflict.
*   **Fix**: Ensure your migration file uses local SQLite syntax. D1 does not support nested transactions. Check for syntax conflicts with:
    ```bash
    npx wrangler d1 migrations list crypto_pulse_db --local
    ```

### B. Android Gradle Daemon Errors
*   **Symptom**: Gradle locks files or out-of-memory errors occur.
*   **Fix**: Stop any lingering Gradle daemons using:
    ```bash
    .\gradlew.bat --stop
    ```

### C. Delta Exchange Cold-Start Warns
*   **Symptom**: `[Delta] Cold-start metadata download failed: Error: Delta API error` in test console.
*   **Details**: This occurs if the exchange API endpoint is offline during test execution. The adapter is configured to retry internally and fall back to the last cached state.
