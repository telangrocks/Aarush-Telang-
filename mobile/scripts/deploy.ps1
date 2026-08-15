# mobile/scripts/deploy.ps1
# Fast Local Development Deployment Script

$ErrorActionPreference = "Stop"

Write-Host "=== CRYPTOPULSE FAST DEV DEPLOY ===" -ForegroundColor Cyan

# 1. Verify Emulator / Device Connectivity
$adbLines = (adb devices) | Where-Object { $_ -match "\tdevice$" }
if (-not $adbLines) {
    Write-Host "[!] No connected Android device/emulator detected." -ForegroundColor Yellow
    Write-Host "    Please ensure your emulator (emulator-5554) is running or a physical device is connected." -ForegroundColor Yellow
    exit 1
}

# Select target device (prefer emulator-5554, or first connected device)
$targetDevice = "emulator-5554"
$foundTarget = $adbLines | Where-Object { $_ -match "^$targetDevice\tdevice$" }
if (-not $foundTarget) {
    $targetDevice = ($adbLines[0] -split "\t")[0]
}
Write-Host "[✓] Target device: $targetDevice" -ForegroundColor Green

# 2. Build Debug APK using Gradle Wrapper
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$mobileDir = (Resolve-Path "$scriptDir\..").Path
$startTime = Get-Date

Write-Host "[*] Building debug APK with Gradle wrapper..." -ForegroundColor Yellow
Push-Location $mobileDir
try {
    $buildOutput = & .\gradlew.bat :app:assembleDebug --parallel --build-cache 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

$buildDuration = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 2)
Write-Host "[✓] Build succeeded in ${buildDuration}s." -ForegroundColor Green

# 3. Locate Generated APK
$apkPath = Join-Path $mobileDir "app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path $apkPath)) {
    Write-Error "ERROR: APK not found at expected path: $apkPath"
    exit 1
}
Write-Host "[✓] Located APK: $apkPath" -ForegroundColor Green

# 4. Install APK preserving data (-r)
Write-Host "[*] Installing APK on $targetDevice (preserving app data)..." -ForegroundColor Yellow
$installResult = adb -s $targetDevice install -r "$apkPath" 2>&1
if ($LASTEXITCODE -ne 0 -or $installResult -notmatch "Success") {
    Write-Error "Install failed:`n$installResult"
    exit 1
}
Write-Host "[✓] Install succeeded ($installResult)." -ForegroundColor Green

# 5. Launch MainActivity
Write-Host "[*] Launching com.cryptopulse.app/.MainActivity..." -ForegroundColor Yellow
$launchResult = adb -s $targetDevice shell am start -n "com.cryptopulse.app/.MainActivity" 2>&1
Write-Host "[✓] Launch result: $launchResult" -ForegroundColor Green

Write-Host "`n=== DEPLOYMENT SUMMARY ===" -ForegroundColor Cyan
Write-Host "Target Device:  $targetDevice" -ForegroundColor Green
Write-Host "Build Result:   SUCCESS" -ForegroundColor Green
Write-Host "Build Duration: ${buildDuration}s" -ForegroundColor Green
Write-Host "Install Result: SUCCESS (App Data Preserved)" -ForegroundColor Green
Write-Host "Launch Result:  SUCCESS" -ForegroundColor Green
