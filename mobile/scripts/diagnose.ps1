# mobile/scripts/diagnose.ps1
# Fast Local Development Diagnostic Script

$ErrorActionPreference = "Stop"

Write-Host "=== CRYPTOPULSE DEV DIAGNOSE ===" -ForegroundColor Cyan

# 1. Verify Device Connectivity
$adbLines = (adb devices) | Where-Object { $_ -match "\tdevice$" }
if (-not $adbLines) {
    Write-Host "[!] No connected Android device/emulator detected." -ForegroundColor Yellow
    Write-Host "    Please ensure your emulator (emulator-5554) is running or a physical device is connected." -ForegroundColor Yellow
    exit 1
}

$targetDevice = "emulator-5554"
$foundTarget = $adbLines | Where-Object { $_ -match "^$targetDevice\tdevice$" }
if (-not $foundTarget) {
    $targetDevice = ($adbLines[0] -split "\t")[0]
}
Write-Host "[✓] Target device: $targetDevice" -ForegroundColor Green

# 2. Setup Output Directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$outputDir = Join-Path $scriptDir "..\build\dev_diagnostics"
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}
$diagDir = (Resolve-Path $outputDir).Path
Write-Host "[✓] Diagnostics folder: $diagDir" -ForegroundColor Green

# 3. Check App Process Status
$pkgName = "com.cryptopulse.app"
$pidOutput = adb -s $targetDevice shell pidof $pkgName 2>&1
$pidVal = ($pidOutput -join "").Trim()

if ($pidVal -match '^\d+$') {
    Write-Host "[✓] Process '$pkgName' is RUNNING (PID: $pidVal)." -ForegroundColor Green
} else {
    Write-Host "[!] Process '$pkgName' is NOT currently running." -ForegroundColor Yellow
    $pidVal = $null
}

# 4. Capture Foreground Activity
$focusOutput = adb -s $targetDevice shell "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'" 2>&1
$focusFile = Join-Path $diagDir "foreground_activity.txt"
$focusOutput | Out-File -FilePath $focusFile -Encoding utf8
Write-Host "[✓] Captured Foreground Activity -> $focusFile" -ForegroundColor Green

# 5. Capture Screenshot
$screenshotFile = Join-Path $diagDir "screenshot.png"
adb -s $targetDevice exec-out screencap -p > "$screenshotFile"
Write-Host "[✓] Captured Screenshot -> $screenshotFile" -ForegroundColor Green

# 6. Capture Filtered Logcat
$logcatFile = Join-Path $diagDir "logcat.log"
if ($pidVal) {
    # Stream logs by PID if running
    $rawLogcat = adb -s $targetDevice logcat -d -v time --pid=$pidVal 2>&1
} else {
    # Fallback to grepping package name & errors
    $rawLogcat = adb -s $targetDevice logcat -d -v time | Select-String -Pattern "cryptopulse|AndroidRuntime|FATAL|Exception|Throwable"
}
$rawLogcat | Out-File -FilePath $logcatFile -Encoding utf8
Write-Host "[✓] Captured Logcat -> $logcatFile" -ForegroundColor Green

# 7. Summary
Write-Host "`n=== DIAGNOSTIC REPORT ===" -ForegroundColor Cyan
Write-Host "Target Device:       $targetDevice"
Write-Host "Package:             $pkgName"
Write-Host "PID:                 $(if ($pidVal) { $pidVal } else { 'NOT RUNNING' })"
Write-Host "Foreground Activity: $(($focusOutput -join ' ') -replace '^\s+', '')"
Write-Host "Saved Screenshot:    $screenshotFile"
Write-Host "Saved Logcat Log:    $logcatFile"
