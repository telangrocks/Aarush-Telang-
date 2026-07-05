param(
    [switch]$SkipChecks,
    [string]$CommitMessage
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-Git {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Invoke-Check {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Script
    )

    Write-Step $Name
    & $Script
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

function Get-CommitMessageFromDiff {
    $diff = git diff --cached -- . ':(exclude)package-lock.json'
    if (-not $diff) {
        return 'Update project files'
    }

    $changedFiles = git diff --cached --name-only
    $fileList = ($changedFiles | Select-Object -First 5) -join ', '

    $prompt = @"
Write a short imperative git commit message for these staged changes.

Rules:
- subject line only unless a body is genuinely necessary
- max 50 characters if possible
- capitalize the subject
- no trailing period
- focus on the actual code/config change

Changed files:
$fileList

Diff:
$diff
"@

    $message = $null

    if (Get-Command ollama -ErrorAction SilentlyContinue) {
        try {
            $message = $prompt | ollama run llama3.1 2>$null
        } catch {
            $message = $null
        }
    }

    if (-not $message) {
        if ($changedFiles -match '^\.github/workflows/') {
            return 'Fix CI workflow configuration'
        }
        if ($changedFiles -match '^backend/') {
            return 'Fix backend build issues'
        }
        if ($changedFiles -match '^mobile/') {
            return 'Fix Android project configuration'
        }
        return 'Update project files'
    }

    $message = ($message -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
    if (-not $message) {
        return 'Update project files'
    }

    return $message
}

Set-Location $PSScriptRoot

Write-Step 'Review repository status'
git status --short --branch
if ($LASTEXITCODE -ne 0) {
    throw 'git status failed'
}

$branch = (git branch --show-current).Trim()
if (-not $branch) {
    throw 'Unable to determine current git branch'
}

$statusOutput = git status --porcelain
if (-not $statusOutput) {
    Write-Host 'No local changes to commit.' -ForegroundColor Yellow
    exit 0
}

Write-Step 'Review diff summary'
git --no-pager diff --stat
if ($LASTEXITCODE -ne 0) {
    throw 'git diff --stat failed'
}

if (-not $SkipChecks) {
    if (Test-Path 'backend/package.json') {
        Push-Location 'backend'
        try {
            Invoke-Check 'Backend install' { npm ci }
            Invoke-Check 'Backend lint' { npm run lint }
            Invoke-Check 'Backend build' { npm run build }
            Invoke-Check 'Backend tests' { npm test }
        } finally {
            Pop-Location
        }
    }

    if (Test-Path 'mobile/settings.gradle.kts') {
        if (Test-Path 'mobile/gradlew.bat') {
            Push-Location 'mobile'
            try {
                Invoke-Check 'Android build' { .\gradlew.bat assembleDebug --stacktrace }
            } finally {
                Pop-Location
            }
        } else {
            Write-Host 'Skipping Android build: gradlew.bat not found.' -ForegroundColor Yellow
        }
    }
}

Write-Step 'Stage changes'
Invoke-Git -Arguments @('add', '--all')

$stagedStatus = git diff --cached --name-only
if (-not $stagedStatus) {
    Write-Host 'No staged changes after git add.' -ForegroundColor Yellow
    exit 0
}

if (-not $CommitMessage) {
    Write-Step 'Generate commit message'
    $CommitMessage = Get-CommitMessageFromDiff
}

$CommitMessage = $CommitMessage.Trim()
if (-not $CommitMessage) {
    throw 'Generated commit message was empty'
}

Write-Host "Commit message: $CommitMessage" -ForegroundColor Green

Write-Step 'Commit changes'
Invoke-Git -Arguments @('commit', '-m', $CommitMessage)

Write-Step "Push to origin/$branch"
Invoke-Git -Arguments @('push', 'origin', $branch)

Write-Host "`nAutomation complete. Changes pushed to $branch." -ForegroundColor Green
