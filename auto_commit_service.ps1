# auto_commit_service.ps1
# -------------------------------------------------
# Watches the repo at C:\Crypto Pulse ( New) and auto‑commits/pushes
# -------------------------------------------------

# ---- Configuration -------------------------------------------------
$RepoRoot   = 'C:\Crypto Pulse ( New)'   # absolute repo path
$BranchName = 'main'           # target branch
$DebounceMs = 3000            # wait after last change (ms)
# -------------------------------------------------------------------

function Invoke-Git {
    param([string]$Args)
    & git $Args 2>&1 | ForEach-Object { Write-Host $_ }
}

# .NET FileSystemWatcher
$Watcher = New-Object System.IO.FileSystemWatcher $RepoRoot, '*'
$Watcher.IncludeSubdirectories = $true
$Watcher.EnableRaisingEvents    = $true

$Timer = $null
function On-Change {
    if ($Timer) { $Timer.Stop(); $Timer.Dispose() }
    $Timer = New-Object Timers.Timer $DebounceMs
    $Timer.AutoReset = $false
    $Timer.Add_Elapsed({
        Invoke-Git 'add .'
        $Status = git status --porcelain
        if ($Status) {
            $msg = "auto: 2026-06-23T16:27:09+05:30"
            Invoke-Git "commit -m "$msg""
            Invoke-Git "push origin $BranchName"
        } else {
            Write-Host "🟢 No changes to commit."
        }
    })
    $Timer.Start()
}

# Register events
Register-ObjectEvent $Watcher Created  -Action { On-Change }
Register-ObjectEvent $Watcher Changed  -Action { On-Change }
Register-ObjectEvent $Watcher Deleted  -Action { On-Change }
Register-ObjectEvent $Watcher Renamed  -Action { On-Change }

Write-Host "🚀 Auto-commit service started - watching $RepoRoot"
while ($true) { Start-Sleep -Seconds 5 }
