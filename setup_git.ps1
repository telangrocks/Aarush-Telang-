Write-Host "Setting up Git repository for Crypto Pulse..." -ForegroundColor Cyan

# Ensure git is initialized
if (!(Test-Path .git)) {
    git init
    Write-Host "Initialized local Git repository." -ForegroundColor Green
}

# Set remote origin
git remote remove origin 2>$null
git remote add origin https://github.com/telangrocks/Aarush-Telang-.git
Write-Host "Set remote origin to https://github.com/telangrocks/Aarush-Telang-.git" -ForegroundColor Green

# Add files
git add .gitignore .github/ backend/ mobile/ PROJECT_CONTEXT.md ARCHITECTURE.md PROGRESS.md PROJECT_STRUCTURE.md
Write-Host "Staged files for commit." -ForegroundColor Green

# Commit
git commit -m "Initialize Crypto Pulse project structure (Android Compose + Cloudflare Workers Hono)"
Write-Host "Committed files locally." -ForegroundColor Green

# Push
Write-Host "Pushing to GitHub (main branch)..." -ForegroundColor Cyan
git branch -M main
git push -u origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host "SUCCESS! The files have been successfully pushed to GitHub." -ForegroundColor Green
} else {
    Write-Host "ERROR: Push failed. Please make sure you are logged in to GitHub in this terminal (try running 'gh auth login' or setting up git credentials)." -ForegroundColor Red
}

Write-Host "Press any key to close..."
$null = [System.Console]::ReadKey($true)
