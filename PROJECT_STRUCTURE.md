# Project Structure & Organization

**Last Updated:** 2026-06-22  
**Status:** Template ready (will be created after Phase 0)

---

## 📁 Directory Tree (To Be Created)

```
project-root/
│
├── 📄 PROJECT_CONTEXT.md          # ← Main project overview (START HERE)
├── 📄 PROGRESS.md                 # ← Task tracking & session notes
├── 📄 ARCHITECTURE.md             # ← Tech stack & design decisions
├── 📄 PROJECT_STRUCTURE.md        # ← This file
├── 📄 README.md                   # ← GitHub repository README
├── 📄 .gitignore                  # ← Git ignore rules
│
├── 📂 backend/
│   ├── src/
│   │   ├── index.ts               # Main entry point
│   │   ├── config/                # Configuration files
│   │   │   ├── database.ts
│   │   │   ├── env.ts
│   │   │   └── constants.ts
│   │   ├── services/              # Business logic
│   │   │   ├── auth.ts            # Authentication
│   │   │   ├── user.ts            # User management
│   │   │   ├── [feature].ts       # Feature services
│   │   │   └── index.ts
│   │   ├── routes/                # API endpoints
│   │   │   ├── auth.ts
│   │   │   ├── users.ts
│   │   │   ├── [feature].ts
│   │   │   └── index.ts
│   │   ├── middleware/            # Express/custom middleware
│   │   │   ├── auth.ts
│   │   │   ├── errorHandler.ts
│   │   │   ├── logger.ts
│   │   │   └── index.ts
│   │   ├── models/                # Database models/schemas
│   │   │   ├── User.ts
│   │   │   ├── [Entity].ts
│   │   │   └── index.ts
│   │   ├── utils/                 # Utility functions
│   │   │   ├── validators.ts
│   │   │   ├── helpers.ts
│   │   │   ├── errors.ts
│   │   │   └── index.ts
│   │   └── types/                 # TypeScript types/interfaces
│   │       ├── index.ts
│   │       └── [domain].types.ts
│   │
│   ├── tests/
│   │   ├── unit/                  # Unit tests
│   │   │   ├── services.test.ts
│   │   │   ├── utils.test.ts
│   │   │   └── models.test.ts
│   │   ├── integration/           # Integration tests
│   │   │   ├── api.test.ts
│   │   │   ├── database.test.ts
│   │   │   └── auth.test.ts
│   │   └── fixtures/              # Test data & mocks
│   │       ├── mockData.ts
│   │       └── testHelpers.ts
│   │
│   ├── wrangler.toml              # Cloudflare Workers config
│   ├── package.json               # Dependencies
│   ├── tsconfig.json              # TypeScript config
│   ├── .env.example               # Example env variables
│   ├── .env.local                 # Local env (git ignored)
│   ├── .prettierrc                # Code formatting
│   ├── .eslintrc.json             # Linting rules
│   └── README.md                  # Backend-specific docs
│
├── 📂 mobile/
│   ├── 📁 (Structure depends on React Native/Flutter/etc)
│   │
│   ├── src/                       # Source code
│   │   ├── screens/               # App screens
│   │   │   ├── HomeScreen.tsx
│   │   │   ├── AuthScreen.tsx
│   │   │   ├── [FeatureScreen].tsx
│   │   │   └── index.ts
│   │   ├── components/            # Reusable components
│   │   │   ├── Header.tsx
│   │   │   ├── Button.tsx
│   │   │   ├── Card.tsx
│   │   │   ├── Form.tsx
│   │   │   ├── common/            # Common components
│   │   │   └── index.ts
│   │   ├── navigation/            # Navigation setup
│   │   │   ├── Navigator.tsx
│   │   │   ├── routes.ts
│   │   │   └── types.ts
│   │   ├── services/              # API calls & services
│   │   │   ├── api.ts             # API client
│   │   │   ├── auth.ts
│   │   │   ├── [feature].ts
│   │   │   └── index.ts
│   │   ├── state/                 # State management (Redux/Zustand)
│   │   │   ├── store.ts           # Store setup
│   │   │   ├── slices/
│   │   │   │   ├── authSlice.ts
│   │   │   │   ├── userSlice.ts
│   │   │   │   └── [featureSlice].ts
│   │   │   └── index.ts
│   │   ├── hooks/                 # Custom React hooks
│   │   │   ├── useAuth.ts
│   │   │   ├── useApi.ts
│   │   │   └── index.ts
│   │   ├── utils/                 # Utility functions
│   │   │   ├── validators.ts
│   │   │   ├── formatters.ts
│   │   │   ├── storage.ts         # Local storage/AsyncStorage
│   │   │   └── index.ts
│   │   ├── styles/                # Global styles & theme
│   │   │   ├── colors.ts
│   │   │   ├── spacing.ts
│   │   │   ├── typography.ts
│   │   │   ├── theme.ts
│   │   │   └── index.ts
│   │   ├── types/                 # TypeScript types
│   │   │   ├── index.ts
│   │   │   └── [domain].types.ts
│   │   ├── assets/                # Images, fonts, etc
│   │   │   ├── images/
│   │   │   ├── icons/
│   │   │   ├── fonts/
│   │   │   └── animations/
│   │   └── App.tsx                # Main app component
│   │
│   ├── tests/
│   │   ├── unit/                  # Unit tests
│   │   ├── integration/           # Integration tests
│   │   ├── e2e/                   # End-to-end tests
│   │   └── fixtures/              # Test data
│   │
│   ├── android/                   # Android-specific (React Native)
│   ├── ios/                       # iOS-specific (React Native)
│   ├── app.json                   # App configuration
│   ├── package.json               # Dependencies
│   ├── tsconfig.json              # TypeScript config
│   ├── .prettierrc                # Code formatting
│   ├── .eslintrc.json             # Linting rules
│   └── README.md                  # Mobile-specific docs
│
├── 📂 docs/
│   ├── README.md                  # Documentation index
│   ├── SETUP.md                   # Setup instructions
│   ├── API_SPECIFICATION.md       # API reference
│   ├── DATABASE_SCHEMA.md         # DB design
│   ├── DEPLOYMENT.md              # Deployment guide
│   ├── TESTING.md                 # Testing guide
│   ├── CONTRIBUTING.md            # Contribution guidelines
│   └── TROUBLESHOOTING.md         # Common issues & solutions
│
├── 📂 .github/
│   ├── workflows/
│   │   ├── ci-cd.yml              # Main CI/CD workflow
│   │   ├── code-review.yml        # Code review workflow
│   │   ├── deploy.yml             # Deployment workflow
│   │   └── tests.yml              # Test workflow
│   │
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   │
│   └── pull_request_template.md
│
├── .gitignore                     # Git ignore rules
├── .editorconfig                  # Editor config
├── README.md                      # Main README for GitHub
└── package.json                   # Root package.json (if monorepo)
```

---

## 📂 What Each Folder Contains

### `/backend`
- All server-side code
- API routes and endpoints
- Database models and migrations
- Business logic and services
- Tests for backend
- Configuration files (wrangler.toml, .env)
- Dependencies (package.json)

### `/mobile`
- All mobile app code
- UI components and screens
- State management
- API communication layer
- Local storage
- Platform-specific code (android/, ios/)
- Tests for mobile app

### `/docs`
- Comprehensive documentation
- API specifications
- Database schema
- Setup and deployment guides
- Contributing guidelines

### `/.github/workflows`
- GitHub Actions workflows
- Automated testing
- Automated deployment
- Code review automation

---

## 📋 File Naming Conventions

### TypeScript/JavaScript Files
- **Components:** PascalCase (e.g., `UserProfile.tsx`)
- **Hooks:** camelCase with 'use' prefix (e.g., `useAuth.ts`)
- **Services/Utils:** camelCase (e.g., `apiClient.ts`)
- **Tests:** Same name + `.test.ts` (e.g., `utils.test.ts`)

### Folders
- **Always lowercase**
- **Use plural for collections** (e.g., `services/`, `components/`)
- **Descriptive names** (e.g., `authentication/`, not `auth/`)

### Configuration Files
- Environment: `.env.example`, `.env.local`
- TypeScript: `tsconfig.json`
- Linting: `.eslintrc.json`
- Formatting: `.prettierrc`

---

## 🔄 How to Navigate This Structure

### For Backend Development:
1. Start in `/backend/src/`
2. Check `/backend/src/routes/` for API endpoints
3. See `/backend/src/services/` for business logic
4. Review `/backend/src/models/` for data structures

### For Frontend Development:
1. Start in `/mobile/src/screens/` for pages
2. Check `/mobile/src/components/` for UI components
3. See `/mobile/src/services/` for API calls
4. Review `/mobile/src/state/` for state management

### For Configuration:
1. Backend config: `/backend/wrangler.toml`, `/backend/.env.local`
2. Mobile config: `/mobile/app.json`, `/mobile/.env.local`
3. Git config: `/.gitignore`, `/.editorconfig`

### For Documentation:
1. Start with `/README.md` (project overview)
2. Check `/docs/SETUP.md` for setup
3. See `/docs/API_SPECIFICATION.md` for API details
4. Review `/docs/DATABASE_SCHEMA.md` for data model

---

## 📝 Creating New Files

### Backend Service:
1. Create file in `/backend/src/services/[name].ts`
2. Export main function/class
3. Add corresponding test in `/backend/tests/unit/[name].test.ts`

### Mobile Component:
1. Create folder in `/mobile/src/components/[ComponentName]/`
2. Create `[ComponentName].tsx` (component file)
3. Create `index.ts` (exports)
4. Create `types.ts` (component props types) if needed
5. Create `styles.ts` (component styles) if needed
6. Create `[ComponentName].test.tsx` (tests)

### API Endpoint:
1. Create file in `/backend/src/routes/[feature].ts`
2. Define route handlers
3. Add to `/backend/src/routes/index.ts`
4. Add tests in `/backend/tests/integration/[feature].test.ts`

---

## 🚀 Development Workflow with This Structure

### Starting a New Feature:
1. Create feature branch
2. Add route in `/backend/src/routes/` if needed
3. Add service in `/backend/src/services/` for logic
4. Add screen/component in `/mobile/src/screens/` or `/mobile/src/components/`
5. Add tests alongside code
6. Push → GitHub Actions runs
7. Fix any issues from automated review
8. Merge when approved
9. Automatically deployed

---

## ✅ Best Practices

- **Keep folders shallow** (max 3-4 levels deep)
- **Co-locate related files** (component + styles + tests together)
- **Use index.ts files** for clean exports
- **Separate concerns** (don't mix API logic with UI)
- **Document complex sections** with comments
- **Keep files focused** (one responsibility per file)

---

## 🔗 Related Files
- `PROJECT_CONTEXT.md` - Overall project info
- `PROGRESS.md` - Task tracking
- `ARCHITECTURE.md` - Tech stack & design decisions

