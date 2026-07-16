# CryptoPulse adaptive launcher icon generator.
# Renders the in-app "C with heartbeat" logo onto a navy rounded-square
# background at every standard mipmap density, for both the foreground
# and background layers of an Android adaptive icon.
#
# Foreground layer  : logo mark only (transparent background) - 108dp safe zone
# Background layer  : solid navy rounded-square fill
#
# Uses .NET System.Drawing (GDI+) via PowerShell - no external deps.

Add-Type -AssemblyName System.Drawing

$base = "C:\Aarush Telang\Aarush-Telang-\mobile\app\src\main\res"

# Densities -> drawable folder + pixel size of the full 108dp layer.
$densities = @{
    "mdpi"    = 108
    "hdpi"    = 162
    "xhdpi"   = 216
    "xxhdpi"  = 324
    "xxxhdpi" = 432
}

# Brand colours
$navyBg   = [System.Drawing.Color]::FromArgb(255, 5, 13, 31)    # NavyDeep 050D1F
$cyan     = [System.Drawing.Color]::FromArgb(255, 0, 180, 255)  # CyanPrimary 00B4FF
$blue     = [System.Drawing.Color]::FromArgb(255, 26, 111, 255) # 1A6FFF
$white    = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

function New-Bitmap($size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $bmp.SetResolution(96, 96)
    return $bmp
}

function Get-ColorAt([System.Drawing.Color]$a, [System.Drawing.Color]$b, [double]$t) {
    $r = [int]($a.R + ($b.R - $a.R) * $t)
    $g = [int]($a.G + ($b.G - $a.G) * $t)
    $bl = [int]($a.B + ($b.B - $a.B) * $t)
    return [System.Drawing.Color]::FromArgb(255, $r, $g, $bl)
}

# Draw a thick rounded "C" arc with a vertical cyan->blue gradient.
function Draw-Arc($g, $size) {
    $cx = $size / 2.0
    $cy = $size / 2.0
    $radius = $size * 0.40
    $strokeW = $size * 0.085

    # Approximate the sweep gradient by stacking thin arc segments.
    $startDeg = 120.0
    $sweepDeg = 300.0
    $steps = 120
    $stepDeg = $sweepDeg / $steps
    for ($i = 0; $i -lt $steps; $i++) {
        $t = $i / [double]($steps - 1)
        $col = Get-ColorAt $cyan $blue $t
        $pen = New-Object System.Drawing.Pen($col, $strokeW)
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
        $a0 = ($startDeg + $i * $stepDeg) * [Math]::PI / 180.0
        $a1 = ($startDeg + ($i + 1) * $stepDeg) * [Math]::PI / 180.0
        $rect = New-Object System.Drawing.Rectangle(
            [int]($cx - $radius), [int]($cy - $radius),
            [int]($radius * 2), [int]($radius * 2))
        # GDI arc takes degrees (clockwise from x-axis). Convert our math angles.
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.DrawArc($pen, $rect, ($startDeg + $i * $stepDeg), $stepDeg)
        $pen.Dispose()
    }

    # Pixel dot trail on the open end (top-right gap near 120deg start edge).
    $dotR = $strokeW * 0.30
    $dotSp = $strokeW * 0.80
    $edgeAng = (120.0) * [Math]::PI / 180.0
    $tx = $cx + [Math]::Cos($edgeAng) * $radius
    $ty = $cy + [Math]::Sin($edgeAng) * $radius
    for ($i = 0; $i -le 3; $i++) {
        $alpha = [int](255 * (1.0 - $i * 0.22))
        if ($alpha -lt 0) { $alpha = 0 }
        $dc = [System.Drawing.Color]::FromArgb($alpha, $cyan.R, $cyan.G, $cyan.B)
        $brush = New-Object System.Drawing.SolidBrush($dc)
        $dx = $tx + $dotSp * 0.9 * $i
        $dy = $ty - $dotSp * 0.5 * $i
        $g.FillEllipse($brush, ($dx - $dotR), ($dy - $dotR), ($dotR * 2), ($dotR * 2))
        $brush.Dispose()
    }
}

# Draw the white heartbeat / ECG line through the centre.
function Draw-Heartbeat($g, $size) {
    $cx = $size / 2.0
    $cy = $size / 2.0
    $segW = $size * 0.12
    $peak = $size * 0.20
    $lineStroke = $size * 0.045

    $pen = New-Object System.Drawing.Pen($white, $lineStroke)
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $pts = [System.Drawing.PointF[]] @(
        (New-Object System.Drawing.PointF(($cx - $segW * 2.2), $cy)),
        (New-Object System.Drawing.PointF(($cx - $segW * 0.8), $cy)),
        (New-Object System.Drawing.PointF(($cx - $segW * 0.2), ($cy - $peak))),
        (New-Object System.Drawing.PointF(($cx + $segW * 0.4), ($cy + $peak * 0.6))),
        (New-Object System.Drawing.PointF(($cx + $segW * 1.0), $cy)),
        (New-Object System.Drawing.PointF(($cx + $segW * 2.2), $cy))
    )
    $g.DrawLines($pen, $pts)
    $pen.Dispose()
}

function RoundedSquare($size, $radiusFrac) {
    $bmp = New-Bitmap $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    $radius = $size * $radiusFrac
    $brush = New-Object System.Drawing.SolidBrush($navyBg)
    $g.FillRectangle($brush, 0, 0, $size, $size) # full bleed (masked by adaptive shape)
    $brush.Dispose()
    $g.Dispose()
    return $bmp
}

function Foreground($size) {
    $bmp = New-Bitmap $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    Draw-Arc $g $size
    Draw-Heartbeat $g $size
    $g.Dispose()
    return $bmp
}

foreach ($d in $densities.GetEnumerator()) {
    $folder = $d.Key
    $px = $d.Value

    # Background layer
    $bgDir = Join-Path $base "mipmap-anydpi-v26"
    $fgDir = Join-Path $base "mipmap-$folder"
    if (-not (Test-Path $fgDir)) { New-Item -ItemType Directory -Path $fgDir | Out-Null }

    $fg = Foreground $px
    $fg.Save((Join-Path $fgDir "ic_launcher_foreground.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $fg.Dispose()

    # Legacy (non-adaptive) launcher: full icon = background + foreground
    $bgFull = RoundedSquare $px 0.22
    $g2 = [System.Drawing.Graphics]::FromImage($bgFull)
    $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g2.DrawImage((Foreground $px), 0, 0)
    $g2.Dispose()
    $bgFull.Save((Join-Path $fgDir "ic_launcher.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bgFull.Dispose()

    # Rounded icon (legacy round)
    $round = RoundedSquare $px 0.5
    $g3 = [System.Drawing.Graphics]::FromImage($round)
    $g3.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g3.DrawImage((Foreground $px), 0, 0)
    $g3.Dispose()
    $round.Save((Join-Path $fgDir "ic_launcher_round.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $round.Dispose()

    Write-Host "Generated mipmap-$folder ($px px)"
}

# Adaptive XML resources
$xmlDir = Join-Path $base "mipmap-anydpi-v26"
if (-not (Test-Path $xmlDir)) { New-Item -ItemType Directory -Path $xmlDir | Out-Null }

Set-Content -Path (Join-Path $xmlDir "ic_launcher.xml") -Value @"
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
"@

Set-Content -Path (Join-Path $xmlDir "ic_launcher_round.xml") -Value @"
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
"@

# Background colour resource
$colorDir = Join-Path $base "values"
if (-not (Test-Path $colorDir)) { New-Item -ItemType Directory -Path $colorDir | Out-Null }
Set-Content -Path (Join-Path $colorDir "ic_launcher_background.xml") -Value @"
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#050D1F</color>
</resources>
"@

Write-Host "Done."
