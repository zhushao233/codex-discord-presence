$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$assets = Join-Path $root "assets"
New-Item -ItemType Directory -Force -Path $assets | Out-Null

function New-RoundedPath {
  param(
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )

  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

$bitmap = [System.Drawing.Bitmap]::new(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.Color]::Transparent)

$outerPath = New-RoundedPath 40 40 432 432 92
$gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.PointF]::new(80, 80),
  [System.Drawing.PointF]::new(440, 440),
  [System.Drawing.Color]::FromArgb(255, 88, 101, 242),
  [System.Drawing.Color]::FromArgb(255, 124, 58, 237)
)
$graphics.FillPath($gradient, $outerPath)

$glow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(50, 255, 255, 255))
$graphics.FillEllipse($glow, 40, 40, 250, 250)

$panelPath = New-RoundedPath 100 122 312 294 42
$panelBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(242, 14, 16, 23))
$graphics.FillPath($panelBrush, $panelPath)

$windowDots = @(
  [System.Drawing.PointF]::new(138, 160),
  [System.Drawing.PointF]::new(164, 160),
  [System.Drawing.PointF]::new(190, 160)
)
$dotColors = @(
  [System.Drawing.Color]::FromArgb(255, 248, 113, 113),
  [System.Drawing.Color]::FromArgb(255, 251, 191, 36),
  [System.Drawing.Color]::FromArgb(255, 74, 222, 128)
)
for ($i = 0; $i -lt $windowDots.Count; $i++) {
  $brush = [System.Drawing.SolidBrush]::new($dotColors[$i])
  $graphics.FillEllipse($brush, $windowDots[$i].X - 7, $windowDots[$i].Y - 7, 14, 14)
  $brush.Dispose()
}

$chevronPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 245, 247, 255), 24)
$chevronPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$chevronPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$chevronPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$graphics.DrawLines($chevronPen, @(
  [System.Drawing.PointF]::new(150, 228),
  [System.Drawing.PointF]::new(212, 282),
  [System.Drawing.PointF]::new(150, 336)
))

$cursorPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 87, 242, 135), 24)
$cursorPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$cursorPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($cursorPen, 242, 336, 338, 336)

$onlineBorder = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 14, 16, 23))
$graphics.FillEllipse($onlineBorder, 330, 330, 94, 94)
$onlineBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 87, 242, 135))
$graphics.FillEllipse($onlineBrush, 345, 345, 64, 64)

$iconPath = Join-Path $assets "icon.png"
$logoPath = Join-Path $assets "logo.png"
$bitmap.Save($iconPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Save($logoPath, [System.Drawing.Imaging.ImageFormat]::Png)

$cursorPen.Dispose()
$chevronPen.Dispose()
$gradient.Dispose()
$glow.Dispose()
$panelBrush.Dispose()
$onlineBorder.Dispose()
$onlineBrush.Dispose()
$panelPath.Dispose()
$outerPath.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Host "Generated $iconPath and $logoPath"
