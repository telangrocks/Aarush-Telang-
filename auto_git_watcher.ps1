# Auto Git Watcher & Pusher for Crypto Pulse
# Runs locally in PowerShell to automatically sync all changes to GitHub

$projectPath = "c:\Crypto Pulse ( New)"
Set-Location -Path $projectPath

Clear-Host
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "        CRYPTO PULSE AUTO-GIT WATCHER ACTIVATED      " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "Watching: $projectPath" -ForegroundColor White
Write-Host "Target: https://github.com/telangrocks/Aarush-Telang-" -ForegroundColor White
Write-Host "----------------------------------------------------" -ForegroundColor Gray
Write-Host "Leave this window open. Every time the AI agent writes" -ForegroundColor Yellow
Write-Host "or updates a file, it will be pushed automatically." -ForegroundColor Yellow
Write-Host "====================================================" -ForegroundColor Cyan

# Configure FileSystemWatcher
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $projectPath
$watcher.IncludeSubdirectories = $true
$watcher.EnableRaisingEvents = $true

# Filter out common directories and files
$excludePatterns = @(
    "\.git",
    "\.gradle",
    "\.android",
    "node_modules",
    "build",
    "dist",
    "\.wrangler",
    "\.exe$",
    "\.zip$",
    "\.rar$"
)

# Debounce timer to avoid multiple commits during rapid consecutive file edits
$debounceTimeMs = 3000
$lastChangeEvent = [DateTime]::MinValue
$pendingChanges = $false

function Push-Changes {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Change detected. Syncing to GitHub..." -ForegroundColor Cyan
    
    # Stage changes (respecting .gitignore)
    git add .
    
    # Check if there are actual staged changes
    $status = git status --porcelain
    if ($status) {
        Write-Host "Staged changes:" -ForegroundColor Gray
        $status | Out-String | Write-Host -ForegroundColor DarkGray
        
        # Commit
        git commit -m "auto: Sync updates from agent development workspace"
        
        # Push
        Write-Host "Pushing changes to GitHub..." -ForegroundColor Cyan
        git push origin main
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Sync complete. Successfully pushed to GitHub!" -ForegroundColor Green
        } else {
            Write-Host "❌ Push failed. Please check network connection or Git auth." -ForegroundColor Red
        }
    } else {
        Write-Host "ℹ️ No actual changes to commit." -ForegroundColor Gray
    }
}

# Register events
$onChanged = Register-ObjectEvent $watcher "Changed" -Action {
    $path = $event.SourceEventArgs.FullPath
    
    # Check filters
    $ignore = $false
    foreach ($pattern in $EventSubscriber.MessageData) {
        if ($path -match $pattern) { $ignore = $true; break }
    }
    
    if (!$ignore) {
        $script:lastChangeEvent = [DateTime]::Now
        $script:pendingChanges = $true
    }
} -MessageData $excludePatterns

$onCreated = Register-ObjectEvent $watcher "Created" -Action {
    $path = $event.SourceEventArgs.FullPath
    
    $ignore = $false
    foreach ($pattern in $EventSubscriber.MessageData) {
        if ($path -match $pattern) { $ignore = $true; break }
    }
    
    if (!$ignore) {
        $script:lastChangeEvent = [DateTime]::Now
        $script:pendingChanges = $true
    }
} -MessageData $excludePatterns

# Main loop for debouncing and execution
try {
    while ($true) {
        Start-Sleep -Milliseconds 500
        if ($script:pendingChanges -and (([DateTime]::Now - $script:lastChangeEvent).TotalMilliseconds -gt $debounceTimeMs)) {
            $script:pendingChanges = $false
            Push-Changes
        }
    }
}
finally {
    # Clean up events when script is stopped
    Unregister-Event -SourceIdentifier $onChanged.Name
    Unregister-Event -SourceIdentifier $onCreated.Name
    $watcher.Dispose()
    Write-Host "`nWatcher stopped." -ForegroundColor Red
}
