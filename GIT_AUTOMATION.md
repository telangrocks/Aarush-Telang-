# Git Automation

This repository includes a one-command Git automation script:

- `git_automation.ps1`

## What it does

When you run it, it will:

1. Review current Git status
2. Show a diff summary
3. Run backend checks if available:
   - `npm ci`
   - `npm run lint`
   - `npm run build`
   - `npm test`
4. Run the Android build if `mobile/gradlew.bat` exists
5. Stage all changes
6. Generate a commit message automatically
7. Commit the changes
8. Push to the current Git branch

## How to run it

From the repository root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\git_automation.ps1
```

## Optional flags

### Skip checks

```powershell
powershell -ExecutionPolicy Bypass -File .\git_automation.ps1 -SkipChecks
```

### Provide your own commit message

```powershell
powershell -ExecutionPolicy Bypass -File .\git_automation.ps1 -CommitMessage "Fix backend build"
```

## Notes

- The script pushes to the **current branch**, not a hardcoded branch.
- If there are no changes, it exits cleanly.
- If checks fail, it stops before committing.
- If `ollama` is installed locally, the script will try to generate a better commit message from the staged diff.
- If `ollama` is not installed, it uses a safe fallback message based on the changed files.

## Recommended end-of-session command

Use this whenever we finish a development session:

```powershell
powershell -ExecutionPolicy Bypass -File .\git_automation.ps1
```
