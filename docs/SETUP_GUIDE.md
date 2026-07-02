# Local Development Setup Guide

## Prerequisites

Before you start, ensure you have installed:

- **Node.js** (v18 or higher) - [Download](https://nodejs.org/)
- **Git** - [Download](https://git-scm.com/)
- **Android Studio** (for mobile development) - [Download](https://developer.android.com/studio)
- **VS Code** or your preferred editor

**Verify installations:**
```bash
node --version
npm --version
git --version
```

---

## Backend Setup

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Verify TypeScript Compilation

```bash
npm run build
```

You should see no errors. Output files go to `dist/` folder.

### 3. Start Development Server

```bash
npm run dev
```

Expected output:
```
⛅ Wrangler is serving your Workers project
✨ Listening on http://localhost:8787/
```

### 4. Test the API

In a new terminal:

```bash
# Test health endpoint
curl http://localhost:8787/health

# Test root endpoint
curl http://localhost:8787/
```

You should see JSON responses.

### 5. Run Linting

```bash
npm run lint
```

Expected: No errors or warnings.

### 6. Format Code

```bash
npm run format
```

---

## Mobile Setup

### 1. Open Android Studio

```bash
cd mobile
# Open in Android Studio
```

### 2. Sync Gradle

Android Studio will automatically sync Gradle. If not:
- Click `File` → `Sync Now`
- Wait for sync to complete (1-2 minutes)

### 3. Create Android Virtual Device (Emulator)

1. Open AVD Manager: `Tools` → `Device Manager`
2. Click `Create Virtual Device`
3. Select `Pixel 5` device
4. Select `API 34` image
5. Click `Finish`

### 4. Start Emulator

In Device Manager, click the Play button on your virtual device.

### 5. Build Project

```bash
# In Android Studio, click Build → Build Bundle(s) / APK(s) → Build APK(s)
```

Or from terminal:
```bash
cd mobile
./gradlew build
```

---

## Git Workflow

### Initial Setup

```bash
# Clone the repository (if not already done)
git clone https://github.com/telangrocks/Aarush-Telang-.git
cd Aarush-Telang-

# View all branches
git branch -a

# Switch to phase-1-setup branch
git checkout phase-1-setup
```

### Making Changes

```bash
# Create a feature branch
git checkout -b feature/your-feature-name

# Make your changes...

# Stage changes
git add .

# Commit with clear message
git commit -m "feat: your feature description"

# Push to GitHub
git push origin feature/your-feature-name
```

### Create Pull Request

1. Go to GitHub: https://github.com/telangrocks/Aarush-Telang-
2. Click `Pull Requests`
3. Click `New Pull Request`
4. Select your branch
5. Add description and click `Create Pull Request`

---

## Common Issues

### Backend

**Issue:** `npm install` fails
- **Solution:** Delete `node_modules/` and `package-lock.json`, then run `npm install` again

**Issue:** `wrangler dev` fails to start
- **Solution:** Ensure no other service is running on port 8787. Run `npm run dev` with `--port 8788` flag if needed

**Issue:** TypeScript compilation errors
- **Solution:** Run `npm run type-check` to see detailed errors

### Mobile

**Issue:** Gradle sync fails
- **Solution:** Click `File` → `Invalidate Caches` → `Invalidate and Restart`

**Issue:** Emulator won't start
- **Solution:** In Android Studio, go to `Tools` → `Device Manager` → Delete the device → Create a new one

**Issue:** Build fails
- **Solution:** Run `./gradlew clean` then rebuild

---

## Next Steps

1. ✅ Backend setup complete - Run `npm run dev` to test
2. ✅ Mobile setup complete - Open in Android Studio
3. Ready for Phase 2: CI/CD pipeline setup
4. Ready for Phase 3: First API endpoints

---

## Useful Commands

### Backend
```bash
npm run dev          # Start dev server
npm run build        # Compile TypeScript
npm run lint         # Check code quality
npm run format       # Auto-fix formatting
npm run type-check   # Type checking
npm run deploy       # Deploy to production
```

### Mobile
```bash
./gradlew build      # Build project
./gradlew clean      # Clean build
./gradlew test       # Run unit tests
./gradlew lint       # Run linter
```

### Git
```bash
git status           # See changes
git diff             # View file changes
git log --oneline    # View commit history
git branch -a        # List all branches
```

---

## Documentation

For more information, see:
- `PROJECT_CONTEXT.md` - Project overview
- `ARCHITECTURE.md` - Tech stack decisions
- `PROGRESS.md` - Phase tracking
- `docs/API_SPECIFICATION.md` - API endpoints
